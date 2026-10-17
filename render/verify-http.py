"""HTTP smoke checks against disposable NOFX deployment containers."""
import json
import sys
import urllib.request

base_url = sys.argv[1]
after_restart = '--after-restart' in sys.argv


def request(path, data=None):
    headers = {'Origin': 'https://nofx-verification.example'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(
        base_url + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        assert response.status == 200, path
        return response.read(), response.headers


health, _ = request('/health')
assert json.loads(health)['status'] == 'ok'
config, headers = request('/api/config')
assert headers['Access-Control-Allow-Origin'] == 'https://nofx-verification.example'
assert json.loads(config)['initialized'] == after_restart

if not after_restart:
    for route in ['/', '/planning', '/planning/', '/frontier']:
        body, _ = request(route)
        assert b'<html' in body.lower(), route
    for route in ['/planning/chart.js', '/charting_library/charting_library.standalone.js']:
        body, headers = request(route)
        assert len(body) > 1000 and b'<html' not in body[:100].lower(), route
        assert 'javascript' in headers['Content-Type'], route

credentials = {'email': 'render-check@example.com', 'password': 'Verify-Nofx-2026!Password'}
if not after_restart:
    request('/api/register', credentials)
body, _ = request('/api/login', credentials)
assert json.loads(body).get('token'), 'Login did not return a token'
print('HTTP checks passed' + (' after restart.' if after_restart else '.'))
