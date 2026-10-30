"""Streaming ZIP64 writer. stdin carries portable entries; stdout is only ZIP bytes."""
import base64
import hashlib
import json
import os
import stat
import struct
import sys
import tempfile
import time
import zipfile

CHUNK = 64 * 1024


def emit(value):
    print(json.dumps(value, ensure_ascii=True), file=sys.stderr, flush=True)


def ndjson(file, value):
    file.write((json.dumps(value, ensure_ascii=True) + '\n').encode())


def run():
    config = json.loads(sys.stdin.buffer.readline())
    drive = os.path.realpath(config['driveDir'])
    # Anonymous scratch holds only streamed reports, never file contents or the ZIP.
    scratch = next(path for path in ['/tmp', '/var/tmp'] if os.path.commonpath([drive, path]) != drive)
    started = time.time() * 1000
    counts = dict(drive=0, workspace=0, files=0, directories=0, symlinks=0, bytes=0)
    warning_counts = {}
    last_progress = 0
    with tempfile.TemporaryFile(dir=scratch) as inventory, tempfile.TemporaryFile(dir=scratch) as warnings:
        with zipfile.ZipFile(sys.stdout.buffer, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            def warn(code, path, detail):
                warning({'code': code, 'path': path, 'detail': detail})

            def warning(record):
                ndjson(warnings, record)
                warning_counts[record['code']] = warning_counts.get(record['code'], 0) + 1

            def progress():
                nonlocal last_progress
                now = time.monotonic()
                if now - last_progress > 1:
                    emit({'progress': counts})
                    last_progress = now

            def add(path, chunks, mode=stat.S_IFREG | 0o644, mtime=None, target=None, report=True):
                if path in archive.NameToInfo:
                    raise ValueError('duplicate archive path')
                mtime = time.time() if mtime is None else mtime
                date = time.gmtime(max(315532800, min(mtime, 4354819198)))[:6]
                info = zipfile.ZipInfo(path, date)
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = mode << 16
                if stat.S_ISDIR(mode):
                    info.external_attr |= 0x10
                # Extended Unix timestamp makes mtime independent of extractor timezone.
                if 0 <= mtime <= 0xffffffff:
                    info.extra = struct.pack('<HHBI', 0x5455, 5, 1, int(mtime))
                digest = hashlib.sha256()
                size = 0
                with archive.open(info, 'w', force_zip64=True) as output:
                    for chunk in chunks:
                        output.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                        if report:
                            counts['bytes'] += len(chunk)
                            progress()
                if report:
                    kind = 'directory' if stat.S_ISDIR(mode) else 'symlink' if stat.S_ISLNK(mode) else 'file'
                    entry = dict(path=path, type=kind, mode=mode, mtime=mtime * 1000, bytes=size)
                    if kind == 'file':
                        entry['sha256'] = digest.hexdigest()
                    if target is not None:
                        entry['target'] = target
                    ndjson(inventory, entry)
                    counts['drive' if path.startswith('drive/') else 'workspace'] += 1
                    counts[dict(file='files', directory='directories', symlink='symlinks')[kind]] += 1
                    progress()

            def chunks(file):
                while True:
                    data = file.read(CHUNK)
                    if not data:
                        return
                    yield data

            def changed(before, after):
                return (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)

            def walk(directory, prefix):
                before_dir = os.fstat(directory)
                add(prefix + '/', (), before_dir.st_mode, before_dir.st_mtime)
                # fd-relative opens keep renamed parents anchored; O_NOFOLLOW never reads a swapped symlink.
                with os.scandir(directory) as entries:
                    for entry in entries:
                        path = prefix + '/' + entry.name
                        try:
                            before = os.stat(entry.name, dir_fd=directory, follow_symlinks=False)
                            if stat.S_ISLNK(before.st_mode):
                                target = os.readlink(entry.name, dir_fd=directory)
                                after = os.stat(entry.name, dir_fd=directory, follow_symlinks=False)
                                if changed(before, after):
                                    warn('source_changed', path, 'Link changed during capture')
                                add(path, (os.fsencode(target),), before.st_mode, before.st_mtime, target)
                            elif stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode):
                                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                                if stat.S_ISDIR(before.st_mode):
                                    flags |= os.O_DIRECTORY
                                fd = os.open(entry.name, flags, dir_fd=directory)
                                try:
                                    opened = os.fstat(fd)
                                    if changed(before, opened):
                                        warn('source_changed', path, 'Entry replaced before capture')
                                    if stat.S_ISDIR(opened.st_mode):
                                        walk(fd, path)
                                    elif stat.S_ISREG(opened.st_mode):
                                        # Bound the read to observed size: an active append writer cannot prevent completion.
                                        def file_chunks():
                                            remaining = opened.st_size
                                            while remaining:
                                                try:
                                                    data = os.read(fd, min(CHUNK, remaining))
                                                except OSError:
                                                    warn('unreadable', path, 'Read failed during capture')
                                                    return
                                                if not data:
                                                    return
                                                remaining -= len(data)
                                                yield data
                                        add(path, file_chunks(), opened.st_mode, opened.st_mtime)
                                    else:
                                        warn('source_changed', path, 'Entry changed to unsupported type')
                                    if changed(opened, os.fstat(fd)):
                                        warn('source_changed', path, 'Entry changed during capture')
                                finally:
                                    os.close(fd)
                                after = os.stat(entry.name, dir_fd=directory, follow_symlinks=False)
                                if changed(before, after):
                                    warn('source_changed', path, 'Entry changed during capture')
                            else:
                                warn('unsupported_node', path, 'Socket, FIFO, or device cannot be represented in ZIP')
                        except OSError as error:
                            code = 'disappeared' if error.errno == 2 else 'source_changed' if error.errno in (20, 40, 62) else 'unreadable'
                            warn(code, path, 'Filesystem entry could not be captured (errno %s)' % error.errno)
                if changed(before_dir, os.fstat(directory)):
                    warn('source_changed', prefix, 'Directory changed during capture')

            root = os.open(config['driveDir'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                walk(root, 'drive')
            finally:
                os.close(root)
            for line in sys.stdin.buffer:
                record = json.loads(line)
                if 'code' in record:
                    warning(record)
                    continue
                path = record['path']
                if not path.startswith('workspace/') or any(part in ('', '.', '..') for part in path.split('/')) or '\x00' in path or '\\' in path:
                    raise ValueError('invalid portable record path')
                def record_chunks():
                    for frame in sys.stdin.buffer:
                        value = json.loads(frame)
                        if value is None:
                            return
                        yield base64.b64decode(value, validate=True)
                    raise ValueError('unfinished portable entry')
                add(path, record_chunks(), stat.S_IFREG | (record.get('mode', 0o644) & 0o777), record.get('mtime', started) / 1000)
            add('README.md', (config['readme'].encode(),), report=False)
            inventory.seek(0)
            add('inventory.ndjson', chunks(inventory), report=False)
            warnings.seek(0)
            add('warnings.ndjson', chunks(warnings), report=False)
            summary = dict(config['capture'], format='duet-workspace-backup', version=1, captureStartedAt=started,
                           captureEndedAt=time.time() * 1000, consistency='live',
                           completeness='partial' if warning_counts else 'complete', counts=counts,
                           warningCounts=warning_counts, inventory='inventory.ndjson', warnings='warnings.ndjson')
            add('manifest.json', (json.dumps(summary).encode(),), report=False)
        emit({'summary': summary})


try:
    run()
except Exception as error:
    emit({'error': 'Archive capture failed (%s, errno %s)' % (type(error).__name__, getattr(error, 'errno', None))})
    sys.exit(1)
