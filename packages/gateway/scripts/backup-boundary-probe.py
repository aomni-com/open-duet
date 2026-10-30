"""Explicit expensive gate: python3 scripts/backup-boundary-probe.py. Requires bsdtar."""
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import tempfile
import threading
import time

encoder = Path(__file__).resolve().parents[1] / 'src/backups/encoder.py'
started = time.monotonic()
with tempfile.TemporaryDirectory(prefix='backup-boundary-') as root:
    drive = Path(root) / 'configured-drive'
    drive.mkdir()
    large_size = 4 * 1024**3 + 17
    with (drive / 'large').open('wb') as file:
        file.truncate(large_size)
    archive_path = Path(root) / 'backup.zip'
    with archive_path.open('wb') as output, tempfile.TemporaryFile() as reports:
        child = subprocess.Popen(['python3', '-u', str(encoder)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=reports)
        def produce():
            def send(value):
                child.stdin.write((json.dumps(value) + '\n').encode())
            send(dict(driveDir=str(drive), readme='Fixture', capture=dict(backupId='boundary', workspace=dict(name='Boundary', slug='boundary'), createdAt=0)))
            for index in range(65540):
                send(dict(path='workspace/items/%d' % index))
                send(None)
            child.stdin.close()
        producer = threading.Thread(target=produce)
        producer.start()
        while data := child.stdout.read(64 * 1024):
            output.write(data)
        assert child.wait() == 0
        encoder_rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        producer.join()
        reports.seek(0)
        summary = json.loads(list(reports)[-1])['summary']
    # Independent libarchive reader verifies both central-directory ZIP64 and file-size ZIP64.
    listing = subprocess.check_output(['bsdtar', '-tf', str(archive_path)]).decode().splitlines()
    assert 'workspace/items/65539' in listing
    assert len(listing) == 65546, len(listing)
    reader = subprocess.Popen(['bsdtar', '-xOf', str(archive_path), 'drive/large'], stdout=subprocess.PIPE)
    digest = hashlib.sha256()
    size = 0
    while data := reader.stdout.read(1024 * 1024):
        digest.update(data)
        size += len(data)
    assert reader.wait() == 0
    assert size == large_size, size
    inventory = subprocess.check_output(['bsdtar', '-xOf', str(archive_path), 'inventory.ndjson']).decode().splitlines()
    large = next(record for line in inventory if (record := json.loads(line))['path'] == 'drive/large')
    assert large['sha256'] == digest.hexdigest()
    assert large['bytes'] == size
    assert summary['completeness'] == 'complete'
    print(json.dumps(dict(logicalBytes=size, entries=len(listing), zipBytes=archive_path.stat().st_size,
                         sha256=digest.hexdigest(), encoderMaxRss=encoder_rss,
                         elapsedSeconds=round(time.monotonic()-started,2)), indent=2))
