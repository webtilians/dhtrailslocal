"""Mail from DH Trails (for now, the link to choose a new password), through any SMTP server.

For now a Gmail account with an app password; later the club's own domain. Only the settings change
(SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM; on the server, dhtrails-correo writes them).
Without them, mail is off. Port 587 with STARTTLS: some hosts block outgoing 25 and 465.

    python -m app.mail correo@ejemplo.com    sends a test mail with the current settings
"""
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from . import config

def mail_ready()->bool:
    return bool(config.SMTP_HOST and config.SMTP_USER and config.SMTP_PASSWORD)

def send_mail(to:str,subject:str,text:str,html:str|None=None)->None:
    sender=config.MAIL_FROM or config.SMTP_USER
    msg=EmailMessage()
    msg["From"]=formataddr(("DH Trails",sender))
    msg["To"]=to
    msg["Subject"]=subject
    msg["Message-ID"]=make_msgid(domain=sender.rsplit("@",1)[-1])
    msg.set_content(text)
    if html:msg.add_alternative(html,subtype="html")
    context=ssl.create_default_context()
    if config.SMTP_PORT==465:
        with smtplib.SMTP_SSL(config.SMTP_HOST,465,context=context,timeout=20) as server:
            server.login(config.SMTP_USER,config.SMTP_PASSWORD)
            server.send_message(msg)
    else:
        with smtplib.SMTP(config.SMTP_HOST,config.SMTP_PORT,timeout=20) as server:
            server.starttls(context=context)
            server.login(config.SMTP_USER,config.SMTP_PASSWORD)
            server.send_message(msg)

if __name__=="__main__":
    if len(sys.argv)!=2:sys.exit("Uso: python -m app.mail correo@ejemplo.com")
    if not mail_ready():sys.exit("Falta configurar el correo (SMTP_HOST, SMTP_USER y SMTP_PASSWORD).")
    try:
        send_mail(sys.argv[1],"DH Trails: correo de prueba",
                  "Si lees esto, DH Trails ya puede enviar el enlace para recuperar la contraseña.")
    except smtplib.SMTPAuthenticationError:
        sys.exit("El servidor de correo no acepta la cuenta o la contraseña. Con Gmail hace falta una "
                 "contraseña de aplicación (no la de entrar en Gmail) y la verificación en dos pasos activada.")
    except (OSError,smtplib.SMTPException) as e:
        sys.exit(f"No se pudo enviar: {e}")
    print(f"Enviado a {sys.argv[1]}. Míralo en la bandeja de entrada (o en spam).")
