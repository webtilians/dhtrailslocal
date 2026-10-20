"""Forgotten passwords: a link by mail, valid for an hour and only once."""
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from app import config, mail, security
from app.main import app

PASSWORD = "very-long-testing-password"

@pytest.fixture
def outbox(monkeypatch):
    """Mail on, but kept here instead of sent."""
    sent = []
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.example.com")
    monkeypatch.setattr(config, "SMTP_USER", "dhtrails.app@example.com")
    monkeypatch.setattr(config, "SMTP_PASSWORD", "app-password")
    monkeypatch.setattr(config, "PUBLIC_URL", "https://dh.example.com")
    monkeypatch.setattr(mail, "send_mail", lambda to, subject, text, html=None: sent.append({"to": to, "text": text, "html": html}))
    return sent

def rider(client, name=None):
    email = f"Rider-{uuid.uuid4().hex}@Example.com"
    r = client.post("/api/auth/register", json={"email": email, "password": PASSWORD, "display_name": name})
    assert r.status_code == 201, r.text
    return email, {"Authorization": "Bearer " + r.json()["access_token"]}

def link_token(message):
    return re.search(r"https://dh\.example\.com/contrasena\.html#t=([\w.-]+)", message["text"]).group(1)

def test_without_mail_settings_it_says_so():
    with TestClient(app) as client:
        assert client.get("/api/health").json()["password_reset"] is False
        r = client.post("/api/auth/forgot", json={"email": "nadie@example.com"})
        assert r.status_code == 503 and "organización" in r.json()["detail"]

def test_a_link_by_mail_chooses_a_new_password_once(outbox):
    with TestClient(app) as client:
        assert client.get("/api/health").json()["password_reset"] is True
        name = "Olvida " + uuid.uuid4().hex[:6]
        email, old_session = rider(client, name)
        # The same answer for an address without an account, and no mail.
        unknown = client.post("/api/auth/forgot", json={"email": f"nadie-{uuid.uuid4().hex}@example.com"})
        asked = client.post("/api/auth/forgot", json={"email": email.upper()})
        assert unknown.status_code == asked.status_code == 202 and unknown.json() == asked.json()
        assert [m["to"] for m in outbox] == [email.lower()]
        assert f"Hola {name}:" in outbox[0]["text"] and "60 minutos" in outbox[0]["text"]
        token = link_token(outbox[0])
        assert "contrasena.html#t=" + token in outbox[0]["html"]

        # The link never works as a session.
        assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + token}).status_code == 401
        assert client.post("/api/auth/reset", json={"token": token, "password": "corta"}).status_code == 422
        done = client.post("/api/auth/reset", json={"token": token, "password": "una-nueva-contraseña"})
        assert done.status_code == 200 and done.json()["user"]["display_name"] == name
        new_session = {"Authorization": "Bearer " + done.json()["access_token"]}
        assert client.get("/api/auth/me", headers=new_session).status_code == 200
        # Sessions opened with the old password are over; the link works only once.
        over = client.get("/api/auth/me", headers=old_session)
        assert over.status_code == 401 and "contraseña ha cambiado" in over.json()["detail"]
        again = client.post("/api/auth/reset", json={"token": token, "password": "otra-contraseña-mas"})
        assert again.status_code == 400 and "caducado" in again.json()["detail"]
        assert client.post("/api/auth/login", json={"email": email, "password": PASSWORD}).status_code == 401
        assert client.post("/api/auth/login", json={"email": email, "password": "una-nueva-contraseña"}).status_code == 200

def test_old_links_and_forged_ones_do_not_work(outbox, monkeypatch):
    with TestClient(app) as client:
        email, _ = rider(client)
        monkeypatch.setattr(security, "RESET_MINUTES", -1)
        client.post("/api/auth/forgot", json={"email": email})
        expired = link_token(outbox[-1])
        assert client.post("/api/auth/reset", json={"token": expired, "password": "una-nueva-contraseña"}).status_code == 400
        forged = expired[:-4] + ("AAAA" if not expired.endswith("AAAA") else "BBBB")
        assert client.post("/api/auth/reset", json={"token": forged, "password": "una-nueva-contraseña"}).status_code == 400
        assert client.post("/api/auth/login", json={"email": email, "password": PASSWORD}).status_code == 200

def test_one_account_gets_few_mails(outbox):
    with TestClient(app) as client:
        email, _ = rider(client)
        answers = {client.post("/api/auth/forgot", json={"email": email}).status_code for _ in range(5)}
        assert answers == {202} and len(outbox) == 3

def test_the_mail_goes_out_through_smtp_with_starttls(monkeypatch):
    calls = []
    class FakeSmtp:
        def __init__(self, host, port, timeout):
            calls.append(("connect", host, port))
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return False
        def starttls(self, context):
            calls.append(("starttls",))
        def login(self, user, password):
            calls.append(("login", user, password))
        def send_message(self, msg):
            calls.append(("send", msg["From"], msg["To"], msg["Subject"]))
    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSmtp)
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setattr(config, "SMTP_PORT", 587)
    monkeypatch.setattr(config, "SMTP_USER", "dhtrails.app@gmail.com")
    monkeypatch.setattr(config, "SMTP_PASSWORD", "abcdabcdabcdabcd")
    monkeypatch.setattr(config, "MAIL_FROM", "")
    mail.send_mail("piloto@example.com", "Asunto", "Texto")
    assert calls == [("connect", "smtp.gmail.com", 587), ("starttls",), ("login", "dhtrails.app@gmail.com", "abcdabcdabcdabcd"),
                     ("send", "DH Trails <dhtrails.app@gmail.com>", "piloto@example.com", "Asunto")]
