"""Local regression harness: child-document routes intentionally return no body.
Use ?break_bundle=1 to verify the main page's error surface as well.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        route = self.path.split('?', 1)[0]
        if route.endswith('/demo.html'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return
        if route.endswith('/demo-bundles.js') and 'break_bundle=1' in self.headers.get('Referer', ''):
            self.send_error(503, 'Deliberate demo-bundle failure for local verification')
            return
        prefix = '/guide'
        if self.path.startswith(prefix + '/'):
            self.path = self.path[len(prefix):]
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent / 'site'
    ThreadingHTTPServer(('127.0.0.1', 4199), partial(Handler, directory=str(root))).serve_forever()
