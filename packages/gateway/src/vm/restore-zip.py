"""Drive-only ZIP extraction with streamed payloads.

ZipFile owns central-directory/ZIP64 parsing and decompression/CRC/local-header
checks. Metadata grows with entry count, as in the encoder. No archive-authored
path is followed."""
import datetime
import json
import time
import os
import shutil
import stat
import struct
import sys
import zipfile


processed_bytes = 0
processed_entries = 0
last_report = 0


def progress(phase, size=0, entries=0, flush=False):
    global processed_bytes, processed_entries, last_report
    processed_bytes += size
    processed_entries += entries
    now = time.monotonic()
    if flush or now - last_report >= 10:
        print(json.dumps(dict(phase=phase, bytes=processed_bytes, entries=processed_entries)), flush=True)
        last_report = now


def validate_directory_count(archive, count):
    # ZipFile parses records but does not compare their count with the footer.
    with open(archive, 'rb') as source:
        source.seek(0, os.SEEK_END)
        length = source.tell()
        source.seek(max(0, length - 65557))
        tail = source.read()
        offset = tail.rfind(b'PK\x05\x06')
        if offset < 0 or len(tail) - offset < 22:
            raise ValueError('invalid ZIP footer')
        _, disk, directory_disk, disk_count, total, _, _, comment = struct.unpack_from('<4s4H2IH', tail, offset)
        if disk or directory_disk or disk_count != total or offset + 22 + comment != len(tail):
            raise ValueError('invalid or multi-disk ZIP footer')
        footer = length - len(tail) + offset
        if footer >= 20:
            source.seek(footer - 20)
            locator = source.read(20)
            if locator[:4] == b'PK\x06\x07':
                _, disk, zip64_offset, disks = struct.unpack('<4sIQI', locator)
                if disk or disks != 1:
                    raise ValueError('multi-disk ZIP64 footer')
                source.seek(zip64_offset)
                record = source.read(56)
                if len(record) != 56 or record[:4] != b'PK\x06\x06':
                    raise ValueError('invalid ZIP64 footer')
                _, size, _, _, disk, directory_disk, disk_count, total, _, _ = struct.unpack('<4sQ2H2I4Q', record)
                if size < 44 or disk or directory_disk or disk_count != total:
                    raise ValueError('invalid or multi-disk ZIP64 footer')
        if count != total:
            raise ValueError('ZIP entry count mismatch')


def extract(archive, output, target):
    entries = {}
    directories = set()
    offsets = set()
    scratch_block = os.statvfs(output).f_frsize
    target_block = os.statvfs(target).f_frsize
    scratch_bytes = 0
    target_bytes = 0
    with zipfile.ZipFile(archive) as z:
        validate_directory_count(archive, len(z.infolist()))
        for info in z.infolist():
            if '\0' in info.orig_filename:
                raise ValueError('unsafe ZIP path')
            if info.volume or info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('unsupported ZIP entry encoding')
            name = info.filename[:-1] if info.is_dir() else info.filename
            if not name or name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')):
                raise ValueError('unsafe ZIP entry path')
            mode = info.external_attr >> 16
            kind = 'dir' if info.is_dir() else 'link' if stat.S_ISLNK(mode) else 'file'
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise ValueError('unsupported ZIP node type')
            if (stat.S_ISDIR(mode) and kind != 'dir') or (kind == 'dir' and info.file_size):
                raise ValueError('invalid ZIP directory')
            if name == 'drive' and kind != 'dir':
                raise ValueError('unsafe ZIP Drive root')
            if kind == 'link' and (info.file_size == 0 or info.file_size > 65536):
                raise ValueError('invalid ZIP link size')
            if name in entries or info.header_offset in offsets:
                raise ValueError('duplicate ZIP entry')
            entries[name] = (kind, info)
            offsets.add(info.header_offset)
            progress('index', entries=1)
            # Public open validates local names and overlapping extents without
            # reading payload before the disk-space checks below.
            with z.open(info):
                pass
            if name.startswith('drive/'):
                parent = name if kind == 'dir' else name.rsplit('/', 1)[0]
                while parent:
                    directories.add(parent)
                    parent = parent.rsplit('/', 1)[0] if '/' in parent else ''
                if kind != 'dir':
                    # Round content to filesystem blocks and reserve a block
                    # for each entry's directory/metadata overhead as well.
                    scratch_bytes += ((info.file_size + scratch_block - 1) // scratch_block + 1) * scratch_block
                    target_bytes += ((info.file_size + target_block - 1) // target_block + 1) * target_block
        progress('index', flush=True)
        # Validate ancestors independent of archive order, including outside Drive.
        for name in entries:
            parent = name
            while '/' in parent:
                parent = parent.rsplit('/', 1)[0]
                row = entries.get(parent)
                if row and row[0] != 'dir':
                    raise ValueError('ZIP entry traverses a non-directory')
        # Download already occupies disk; free-space checks reserve extraction
        # plus the target-filesystem copy while retaining the existing Drive.
        scratch = shutil.disk_usage(output).free
        available = shutil.disk_usage(target).free
        same_disk = os.stat(output).st_dev == os.stat(target).st_dev
        reserve = 16 * 1024 * 1024
        directory_count = len(directories)
        scratch_bytes += directory_count * scratch_block
        target_bytes += directory_count * target_block
        if scratch < scratch_bytes + reserve or available < target_bytes + (scratch_bytes if same_disk else 0) + reserve:
            raise ValueError('restore_insufficient_disk_space')
        drive = os.path.join(output, 'drive')
        os.mkdir(drive)
        for name in sorted(entries):
            if not name.startswith('drive/'):
                continue
            kind, info = entries[name]
            path = os.path.join(output, name)
            ensure_directories(output, name.rsplit('/', 1)[0])
            if kind == 'dir':
                ensure_directories(output, name)
            else:
                with z.open(info) as source:
                    if kind == 'link':
                        link = source.read(65537)
                        if len(link) != info.file_size or b'\0' in link:
                            raise ValueError('invalid ZIP link')
                        os.symlink(os.fsdecode(link), path)
                    else:
                        with open(path, 'xb') as dest:
                            while True:
                                block = source.read(1024 * 1024)
                                if not block:
                                    break
                                dest.write(block)
                                progress('extract', size=len(block))
            progress('extract', entries=1)
            if kind != 'dir':
                metadata(path, info, kind)
        # Apply directory permissions last, deepest first, so read-only parents
        # never interfere with extraction of their children.
        for name in sorted(directories, key=len, reverse=True):
            if name.startswith('drive/') and name in entries:
                metadata(os.path.join(output, name), entries[name][1], 'dir')
        progress('extract', flush=True)


def ensure_directories(root, relative):
    # Lexical archive checks cannot detect filesystem aliases (case folding or
    # Unicode normalization). Check actual parents without following links.
    path = root
    for part in relative.split('/'):
        path = os.path.join(path, part)
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            os.mkdir(path)
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('ZIP entry traverses a non-directory')


def metadata(path, info, kind):
    if kind != 'link':
        mode = info.external_attr >> 16
        os.chmod(path, mode & 0o7777 if mode else (0o755 if kind == 'dir' else 0o644))
    timestamp = datetime.datetime(*info.date_time).timestamp()
    # Encoder records exact Unix mtime in the standard extended timestamp field.
    extra = info.extra
    while len(extra) >= 4:
        tag, size = struct.unpack_from('<HH', extra)
        value, extra = extra[4:4 + size], extra[4 + size:]
        if tag == 0x5455 and len(value) >= 5 and value[0] & 1:
            timestamp = struct.unpack_from('<I', value, 1)[0]
    os.utime(path, (timestamp, timestamp), follow_symlinks=False)


try:
    extract(*sys.argv[1:])
except Exception as error:
    print('archive restore rejected: ' + str(error), file=sys.stderr)
    sys.exit(1)
