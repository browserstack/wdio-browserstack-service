WebdriverIO Browserstack Service
==========

> The official BrowserStack WebdriverIO service that integrates your WebdriverIO test suite with BrowserStack.

## Installation


You can simply do it by:

```sh
npm install @browserstack/wdio-browserstack-service --save-dev
```

Instructions on how to install `WebdriverIO` can be found [here.](https://webdriver.io/docs/gettingstarted)


## Configuration

WebdriverIO has Browserstack support out of the box. You should simply set `user` and `key` in your `wdio.conf.js` file. This service plugin provides supports for [Browserstack Tunnel](https://www.browserstack.com/automate/node#setting-local-tunnel). Set `browserstackLocal: true` also to activate this feature.
Reporting of session status on BrowserStack will respect `strict` setting of Cucumber options.

```js
// wdio.conf.js
export.config = {
    // ...
    user: process.env.BROWSERSTACK_USERNAME,
    key: process.env.BROWSERSTACK_ACCESS_KEY,
    services: [
        ['@browserstack/wdio-browserstack-service', {
            browserstackLocal: true
        }]
    ],
    // ...
};
```

## Options

In order to authorize to the BrowserStack service your config needs to contain a [`user`](https://webdriver.io/docs/options#user) and [`key`](https://webdriver.io/docs/options#key) option.

### browserstackLocal
Set this to true to enable routing connections from Browserstack cloud through your computer. You will also need to set `browserstack.local` to true in browser capabilities.

Type: `Boolean`<br />
Default: `false`

### preferScenarioName
Cucumber only. Set this to true to enable updating the session name to the Scenario name if only a single Scenario was ran. Useful when running in parallel with [wdio-cucumber-parallel-execution](https://github.com/SimitTomar/wdio-cucumber-parallel-execution).

Type: `Boolean`<br />
Default: `false`

### opts
Specified optional will be passed down to BrowserstackLocal. See [this list](https://www.browserstack.com/local-testing#modifiers) for details.

Type: `Object`<br />
Default: `{}`

----

For more information on WebdriverIO see the [homepage](https://webdriver.io).
