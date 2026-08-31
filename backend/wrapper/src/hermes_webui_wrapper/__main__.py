"""Entry point: `python -m hermes_webui_wrapper` / `hermes-webui-wrapper`."""

import os


def main() -> None:
    import uvicorn

    host = os.environ.get("HERMES_WRAPPER_HOST", "127.0.0.1")
    port = int(os.environ.get("HERMES_WRAPPER_PORT", "8787"))
    uvicorn.run("hermes_webui_wrapper.app:app", host=host, port=port, factory=False)


if __name__ == "__main__":
    main()
