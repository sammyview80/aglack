"""Loopback reverse-proxy Origin/Host alignment for upstream's CSRF check.

See `align_loopback_proxy_host`'s own docstring for the full mechanism and
the real live bug it fixes (Origin/Host disagreeing through a proxy that
rewrote Host, or a browser reaching this wrapper through rust_gateway
directly at the gateway's own published address).
"""
from __future__ import annotations

import os
import re


def _is_loopback_host(host: str) -> bool:
    name = (host or "").strip().lower()
    if not name:
        return False
    if name.startswith("["):
        return name.startswith("[::1]")
    hostname = name.rsplit("@", 1)[-1]
    if ":" in hostname and not hostname.count(":") > 1:
        hostname = hostname.rsplit(":", 1)[0]
    return hostname in {"127.0.0.1", "localhost", "::1"}


def align_loopback_proxy_host(headers_msg) -> None:
    """When a local reverse proxy rewrites Host, align it with browser Origin.

    Vite/webpack often forward ``Origin: http://127.0.0.1:5173`` but set
    ``Host: 127.0.0.1:8787``. CSRF then fails with "Cross-origin mismatch".
    Only rewrite when both sides are loopback -- never for public hosts.
    Fully self-contained: reads only the given headers_msg and the
    HERMES_WEBUI_ALLOWED_ORIGINS env var, mutates only headers_msg.
    """
    origin = (headers_msg.get("Origin") or "").strip()
    host = (headers_msg.get("Host") or "").strip()
    if not origin or not host:
        return
    m = re.match(r"^(https?)://([^/]+)", origin, re.I)
    if not m:
        return
    origin_host = m.group(2).strip()
    if not origin_host or origin_host.lower() == host.lower():
        return
    if not (_is_loopback_host(origin_host) and _is_loopback_host(host)):
        return
    allowed_origins = {
        value.strip().rstrip("/").lower()
        for value in os.getenv("HERMES_WEBUI_ALLOWED_ORIGINS", "").split(",")
        if value.strip()
    }
    if origin.rstrip("/").lower() not in allowed_origins:
        return
    try:
        del headers_msg["Host"]
    except KeyError:
        pass
    headers_msg["Host"] = origin_host
