# Independent phone outage fallback

The offline fallback generator creates a small reviewed TwiML document for hosting independently in Twilio. It needs no API, database, voice gateway, OpenAI connection, environment secret, or live account call. Generation does **not** publish the document, create a TwiML Bin, configure a fallback URL, change phone routing, or establish that Twilio has run it. Provider setup and dedicated-number acceptance remain separate work.

The default document says the phone assistant is unavailable, says that a request or message's saved status cannot be confirmed, asks the caller to try again later, and hangs up. This preserves uncertainty if an application write completed before its acknowledgment was lost. It does not tell the caller to dial the same forwarded restaurant number immediately, claim that nothing was saved, or promise that staff received anything.

## Generate a review artifact

Use the repository's pinned Node.js 24 and installed dependencies. Put the nonsecret JSON configuration in an ignored directory or an authorized temporary file. An announcement configuration is:

```json
{
  "mode": "announcement",
  "restaurantLabel": "Harbor Table"
}
```

The restaurant label is optional, at most 80 characters, and rendered as XML text through the official Twilio SDK. Keep it limited to the restaurant's approved public name. Custom announcements, instructions, callback URLs, tokens, caller details, and credentials are rejected rather than inserted into the artifact.

```sh
node scripts/generate-phone-fallback.mjs \
  --config /tmp/hostline-fallback-review.json \
  --output artifacts/phone-fallback/review.xml
```

Both paths are explicit. Output must be a new `.xml` file directly inside the repository's ignored `artifacts/phone-fallback` directory. The command refuses overwrite, source-directory output, and existing symlinked artifact directories/files; it creates the artifact with owner-only read/write permissions. It accepts a regular JSON file up to 16 KiB and caps generated XML at 4,000 characters. Success/error messages do not print configuration, numbers, or XML. Inspect the artifact locally before any provider publication; do not commit artifacts containing staff numbers.

## Optional independent staff destination

An operator may generate one bounded Dial only after the restaurant approves an independent staff destination, verifies its ownership and forwarding behavior, and approves the provider's geographic permissions and costs. Setting the approval field is an operator assertion, not proof of ownership or an automated authorization workflow. Use announcement mode until that evidence exists.

The following numbers are synthetic examples:

```json
{
  "mode": "staff",
  "restaurantLabel": "Harbor Table",
  "aiNumber": "+12125550110",
  "publicRestaurantNumber": "+12125550111",
  "knownPlatformNumbers": ["+12125550112"],
  "destination": "+12125550144",
  "independentDestinationApproved": true
}
```

All numbers must be canonical E.164; extensions, SIP addresses, URLs, and malformed numbers are rejected. The destination cannot equal the AI number, the restaurant's public forwarded number, or any supplied known platform number. Supply the complete current platform-number list, at most 50 entries; this configuration is not loaded from or kept synchronized with the application automatically.

The document attempts exactly one `<Dial>` with `answerOnBridge="true"`, a 15-second requested ringing timeout, and a 120-second connected-leg time limit. It has no Dial action URL, child status callback, recording, Gather, Redirect, Stream, arbitrary caller-ID override, or private handoff context. After Dial, the same document plays a neutral transfer-ended message and hangs up. Busy/no-answer/failure do not create a retry or a saved message. An answered line can be voicemail or another automated system; the document cannot prove human pickup or staff receipt.

These are provider-requested per-leg bounds, not an exact total wall-clock guarantee. Twilio ringing variance, announcements, and carrier behavior require real tests. Static number comparisons cannot discover hidden forwarding loops, and they cannot cap a chain of fresh inbound calls caused by an external carrier redirect. Verify that the staff destination does not forward to **any** platform or public forwarded number. Test with a dedicated number and retain provider-level spend/concurrency safeguards. If independence is uncertain, use the announcement/hangup document.

## Configure and test independently

Review the artifact, then host it through an approved provider-hosted TwiML Bin or equivalent resource that remains available while the application, database, AWS deployment, and voice model are unavailable. Configure the dedicated test number's fallback behavior only during an authorized provider setup task. Do not use an application-served URL for an outage path that must survive that application's outage. Twilio's [webhook availability and reliability guidance](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides) describes connection/fallback behavior; verify the selected phone number and call-control flow in the current account.

Acceptance must cover primary webhook failure, malformed/unreachable action responses, a lost acknowledgment after saving, unavailable voice/model service, optional staff answer/busy/no-answer/failure/voicemail, provider time limits, and forwarding-loop absence. A number's fallback URL does not automatically prove that every mid-call failure or a WebSocket disconnect invokes this document. Verify each trigger; the application may need a separate authorized provider control to select fallback for an already active call. Do not infer receipt, delivery, caller consent, or call termination from merely generating XML.

Application owner policy and the environment voice/transfer flags govern application actions. An already published static provider document does **not** query those flags or automatically stop dialing after a policy edit. An incident disabling transfers must separately replace/deactivate the provider-hosted Dial document and select an announcement-only provider route. Record resource ownership, current reviewed artifact, number associations, operator access, and the independent disable/rollback procedure before customer forwarding.

Publishing a staff number to a provider resource may expose it to anyone who can retrieve that resource; a hard-to-guess resource URL is not a privacy guarantee. Review provider resource visibility, account permissions, call metadata/retention, geographic permissions, and billing. No application recording is enabled by this document, but provider-side retention still needs its own configuration and review.

See [voice setup](VOICE_SETUP.md), [call controls](TWILIO_CALL_CONTROL.md), [phone operations](PHONE_OPERATIONS.md), and [security guidance](SECURITY.md). The local generator and synthetic tests establish artifact behavior; provider availability and restaurant readiness remain external evidence.
