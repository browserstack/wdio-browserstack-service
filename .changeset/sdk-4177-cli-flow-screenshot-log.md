---
"@wdio/browserstack-service": patch
---

- Fixed screenshots taken during a Mocha test never appearing in Test Reporting's consolidated logs. Mocha runs through the BrowserStack binary, and on that path the WebDriver result event the screenshot log is built from was never subscribed to, so the screenshot was captured by the browser but never reported. A screenshot denial from the server is now honoured too, where previously it was read as approval.
