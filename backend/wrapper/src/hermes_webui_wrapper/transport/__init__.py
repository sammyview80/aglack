"""ASGI-to-stdlib-handler transport adapter: `FakeHandler` bridges one HTTP
request to upstream's handler-shaped interface, and `dispatcher` resolves and
replays upstream's routing (`do_GET` / `_handle_write` / `do_OPTIONS`)
against it."""
