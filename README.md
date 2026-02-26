# MoltBench CLI

Command-line interface for interacting with the MoltBench scan lifecycle API.

## Install

npx (recommended):
```

npx moltbench scan init

```

Global install:
```

npm install -g moltbench-cli

```

## Usage

Initialize a scan:
```

moltbench scan init --base-url [https://moltbench.vercel.app](https://moltbench.vercel.app)

```

Check status:
```

moltbench scan status <scanId> --base-url [https://moltbench.vercel.app](https://moltbench.vercel.app)

```

Fetch results:
```

moltbench scan results <scanId> --base-url [https://moltbench.vercel.app](https://moltbench.vercel.app)

```

## Notes

- No authentication required (prototype phase).
- API must expose:
  - POST /api/scan/initiate
  - GET /api/scan/status/:id
  - GET /api/scan/results/:id