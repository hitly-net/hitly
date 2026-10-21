# @hitly/plugin-openshell

> **Experimental and unsupported.** OpenShell is no longer listed as an integration in HITLy or on hitly.net. This code stays in the repository for reference and for projects that already use it, but it is not maintained as a supported integration and may change or stop working without notice.

Origin plugin that connects a HITLy project to an OpenShell gateway over gRPC. HITLy uses it to check the connection and to send a reviewer's decision back to the gateway for projects that already use OpenShell.

New projects cannot choose OpenShell in the app. Existing OpenShell projects keep working.

See [`examples/openshell`](../../examples/openshell) for a reference poller.

## Development

```bash
yarn workspace @hitly/plugin-openshell typecheck
yarn workspace @hitly/plugin-openshell test
```
