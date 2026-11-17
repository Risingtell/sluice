# odra-proxy-caller-with-return.wasm

Odra's proxy caller session code, unmodified, from the `odra-casper-rpc-client` 2.9.0 crate
(`resources/proxy_caller_with_return.wasm`, https://github.com/odradev/odra), MIT licence,
SHA-256 `16f0c0b87706fe46a44c0cd12f7b5a7a1be9c4f7c6276e64b64df9c3a3c9de8a`.

Casper only lets session code attach CSPR to a contract call, and WCSPR's `deposit` (wrap) is such
a call, so `Sluice.wrapCspr()` runs this proxy to call it.
