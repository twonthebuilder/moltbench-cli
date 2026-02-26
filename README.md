# MoltBench CLI

Command-line interface for interacting with the MoltBench HTTP API.

## Distribution

This repository is distributed via GitHub, not npm publish.

## Install and run

Install via npx:

```bash
npx -y github:twonthebuilder/moltbench-cli scan init --base-url https://moltbench.vercel.app
```

Or global install via git:

```bash
npm install -g git+https://github.com/twonthebuilder/moltbench-cli.git
```

Version pinning via tags:

```bash
npx -y github:twonthebuilder/moltbench-cli#v0.1.0 ...
```

## Usage

```bash
moltbench scan init --base-url https://moltbench.vercel.app
moltbench scan status <scanId> --base-url https://moltbench.vercel.app
moltbench scan results <scanId> --base-url https://moltbench.vercel.app
```

## API endpoints used

- POST `/api/scan/initiate`
- GET `/api/scan/status/:id`
- GET `/api/scan/results/:id`
