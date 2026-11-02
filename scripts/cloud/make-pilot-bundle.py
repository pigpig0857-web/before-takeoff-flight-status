"""Build a small Cloud Shell upload with an explicit source allowlist; no credentials/data."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[2]
files = {
    'infra/google-cloud/Dockerfile': 'Dockerfile',
    'infra/google-cloud/cloudbuild.yaml': 'cloudbuild.yaml',
    'infra/google-cloud/deploy-pilot.sh': 'deploy-pilot.sh',
    'infra/google-cloud/package.json': 'package.json',
    'infra/google-cloud/package-lock.json': 'package-lock.json',
    'tsconfig.json': 'tsconfig.json',
}
for name in [
    'scripts/cloud/pilot-config.mjs', 'scripts/cloud/storage.mjs',
    'scripts/cloud/run-eva-pilot.mjs', 'scripts/crawler/fetch-eva-form-node.mjs',
    'scripts/crawler/fetch-eva-form.py', 'scripts/crawler/validate-eva-http.ts',
    'src/server/providers/experimental/eva-schedule.ts',
    'src/features/flights/journey-time.ts',
    'src/features/flights/data/airport-timezones.json', 'src/lib/time.ts',
]:
    files[name] = name
target = root / 'data/cache/cloud-deployment/flight-eva-cloud-pilot.zip'
target.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(target, 'w', ZIP_DEFLATED) as bundle:
    for source, destination in files.items():
        bundle.write(root / source, 'flight-eva-cloud-pilot/' + destination)
print(target)
