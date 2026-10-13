A self-signed certificate and key for the network tests only: they let the
tests stand up local TLS servers (a fake censor, an impostor DNS resolver).
They protect nothing and are trusted by nothing. Valid for 100 years so the
tests do not start failing on their own.
