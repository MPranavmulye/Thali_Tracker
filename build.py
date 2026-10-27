"""Builds index.html from app.html (the same file as the Claude artifact). Run: python build.py"""
from pathlib import Path
here = Path(__file__).parent
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<meta name="theme-color" content="#4d8a16"><meta name="apple-mobile-web-app-capable" content="yes">'
        '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Thali">'
        '<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icon-192.png">'
        '<link rel="apple-touch-icon" href="apple-touch-icon.png">'
        '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0;font:14px/1.4 system-ui,-apple-system,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
        '<script src="vendor/supabase.js"></script><script src="config.js"></script><script src="shim.js"></script></head><body>')
(here / "index.html").write_text(head + (here / "app.html").read_text(encoding="utf-8") + "</body></html>", encoding="utf-8")
print("index.html built")
