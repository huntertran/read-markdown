# Remote content check

<style>@import url(https://example.com/x.css); h1 { color: red; }</style>
<style>@font-face { font-family: x; src: url(https://example.com/x.woff2); } p { font-family: x, serif; }</style>

Remote image (blocked when `readMarkdown.security.allowRemoteContent` is off):

![remote](https://www.example.com/remote.png)

Local image (always shown):

![local](images/diagram.svg)
