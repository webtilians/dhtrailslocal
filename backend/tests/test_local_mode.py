from fastapi.testclient import TestClient
import app.main as main


def client(host='127.0.0.1'):
    return TestClient(main.app, base_url='http://127.0.0.1:8000', client=(host, 50000))


def test_local_mode_requires_explicit_opt_in(monkeypatch):
    monkeypatch.setattr(main, 'LOCAL_SINGLE_USER', False)
    assert client().post('/api/auth/local', headers={'X-DH-Local': '1'}).status_code == 404


def test_local_session_rejects_remote_access(monkeypatch):
    monkeypatch.setattr(main, 'LOCAL_SINGLE_USER', True)
    assert client().post('/api/auth/local').status_code == 403
    for headers in ({'Origin': 'https://example.com'}, {'Host': 'example.com'},
                    {'Sec-Fetch-Site': 'cross-site'}):
        assert client().post('/api/auth/local', headers={'X-DH-Local': '1', **headers}).status_code == 403
    assert client('192.168.1.2').post('/api/auth/local', headers={'X-DH-Local': '1'}).status_code == 403


def test_local_profile_is_persistent_without_registration(monkeypatch):
    monkeypatch.setattr(main, 'LOCAL_SINGLE_USER', True)
    headers={'X-DH-Local': '1', 'Origin': 'http://127.0.0.1:8000'}
    first=client().post('/api/auth/local', headers=headers)
    second=client().post('/api/auth/local', headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()['user']['id'] == second.json()['user']['id']
    assert first.json()['user']['local'] is True
    token=second.json()['access_token']
    assert client().get('/api/circuits', headers={'Authorization': 'Bearer '+token}).status_code == 200
    assert client().get('/api/circuits').status_code == 401
