# @browserstack/wdio-browserstack-service

![npm](https://img.shields.io/npm/v/@browserstack/wdio-browserstack-service)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Core SDK for BrowserStack integration used by the WebdriverIO BrowserStack Service.
For user configuration and service options, see the official service README:
[https://github.com/webdriverio/webdriverio/blob/main/packages/wdio-browserstack-service/README.md](https://github.com/webdriverio/webdriverio/blob/main/packages/wdio-browserstack-service/README.md)

## Table of Contents
1. [Overview](#overview)
2. [Code Generation](#code-generation)
3. [Development](#development)
4. [Contributing](#contributing)
5. [License](#license)

## Overview
This package provides the TypeScript-based gRPC client and Protobuf definitions
used internally by the `@wdio/browserstack-service` plugin for WebdriverIO.
It includes:
- Generated TypeScript types and clients from Protobuf definitions.
- Message factory constructors for backward compatibility.

## Installation
This module is included as a dependency of the `@wdio/browserstack-service` package.
Users should install and configure the service as documented in the linked README above.

## Setup & Configuration
Add the service to your WebdriverIO configuration (`wdio.conf.js`):
<!-- Usage is provided by @wdio/browserstack-service. -->
export BROWSERSTACK_USERNAME=your_username
export BROWSERSTACK_ACCESS_KEY=your_access_key
```

## Usage
Import and use the gRPC client and message constructors:
```ts
import { SDKClient, StartBinSessionRequestConstructor } from '@browserstack/wdio-browserstack-service';

// Initialize the client (uses default insecure credentials unless overridden)
const client = new SDKClient('grpc.browserstack.com:443');

// Start a session
const startReq = StartBinSessionRequestConstructor.create({
	binSessionId: this.binSessionId,
	sdkLanguage: CLIUtils.getSdkLanguage(),
	sdkVersion: packageVersion,
	pathProject: process.cwd(),
	pathConfig: path.resolve(process.cwd(), 'browserstack.yml'),
	cliArgs: process.argv.slice(2),
	frameworks: [automationFrameworkDetail.name, testFrameworkDetail.name],
	frameworkVersions,
	language: CLIUtils.getSdkLanguage(),
	testFramework: testFrameworkDetail.name,
	wdioConfig: wdioConfig,
});

client.startBinSession(startReq).then(response => {
	console.log('Started session:', response.binSessionId);
});
```

## Code Generation
This project uses [Buf](https://docs.buf.build/) and `ts-proto` to
generate TypeScript code from Protobuf definitions.

### Prerequisites
- [Buf CLI](https://docs.buf.build/installation)
- Node.js ≥16

### Generate & Build
```bash
# Clean previously generated files
npm run clean

# Generate from .proto files
npm run generate

# Compile to JS and declaration files
npm run build
```

Generated files appear under `dist/` and should be published to npm.

## Development
Clone the repository and install dependencies:
```bash
git clone https://github.com/browserstack/wdio-browserstack-service.git
cd wdio-browserstack-service
npm install
```

Run generation and build:
```bash
npm run build
```

## Contributing
Contributions are welcome! Please open issues or pull requests in the [GitHub repository](https://github.com/browserstack/wdio-browserstack-service).

## License
MIT © BrowserStack