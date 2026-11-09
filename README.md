## Contract

### Message object

Identical over socket.io and REST.

#### Identity
- `uuid`: v4 UUID made by the client before sending. The server uses it to recognize retries and keep exactly one copy (UNIQUE in the DB).

#### Routing
- `sender_id`: set by the server from the verified JWT, never read from the client payload (prevents impersonation). Present in messages clients **receive**, but not part of the payload they **send**.
- `sender_name`: not stored in `messages`; added by `messagesRepo` via a JOIN with `users`, so socket and REST both get it.
- `recipient_id`: user id for 1:1 messages; `null` for group messages.
- `group_id`: group id for group messages; `null` for 1:1 messages.

#### Content
- `body`: trimmed, 1 to 2000 characters. Checked on the client for fast feedback and on the server as the real guard.

#### Time and order
- `seq`: assigned by the server (SQLite AUTOINCREMENT), one global counter. `null` on the client while the message is still sending; a number means sent. After a reconnect the client asks for everything with `seq` greater than its last seen one.
- `sent_at`: client clock (ISO). Display only, not used for ordering because phone clocks can be wrong.
- `created_at`: server clock. Display only, ordering always uses `seq`.

#### Example (1:1 message, pending on the sender's phone)

```json
{
  "seq": null,
  "uuid": "5f0c2a9e-7b41-4d3a-9c18-2e6a1b0f44e1",
  "sender_id": 2,
  "sender_name": "belal",
  "recipient_id": 3,
  "group_id": null,
  "body": "hello",
  "sent_at": "2026-11-20T10:15:30.120Z",
  "created_at": null
}
```

- `seq` and `created_at` are `null` because only the server fills them in. Once the ack arrives, both are set and the bubble flips to "sent".
- `sender_id` and `sender_name` are filled locally only so the phone can draw its own bubble as "mine". They are **not** part of the payload sent to the server, which takes the sender from the JWT.
- A group message swaps the targets: `recipient_id: null`, `group_id: 7`.

#### Validation rule
Exactly one of `recipient_id` / `group_id` must be set:

    if ((recipient_id == null) === (group_id == null)) {
      throw new ServiceError(400, 'exactly one target required');
    }
    // otherwise continue; a passing check throws nothing

### Transport interface

Both transports (socket.io and REST polling) implement exactly this, so `ChatScreen` never knows which one is active.

- `connect(token)`: opens the connection and authenticates with the JWT (socket: in the handshake `auth`; REST: `Authorization: Bearer` header). The server learns who the user is from it, so `sender_id` is never taken from the payload. A bad or missing token is rejected.
- `disconnect()`: closes the connection and stops any polling or listeners. Called on logout.
- `send(msg) -> Promise<message>`: `msg` has `uuid`, the target (`recipient_id` or `group_id`), `body`, `sent_at`. Resolves when the server confirms (socket ack, or REST 201/200) with the stored message, where `seq` is now filled in. While offline it stays in the outbox with `seq = null` ("sending...") and is resent with the same `uuid` on reconnect, so it can't be stored twice.
- `sync(afterSeq) -> Promise<message[]>`: asks for everything with `seq` greater than the client's highest seen `seq`. Returns a list in `seq` order, only messages the user may see. Every item goes through `addMessage()`, which ignores known `uuid`s.
- `onMessage(cb)`: registers a callback called with each new incoming message (live push or poll result).
- `onStatus(cb)`: registers a callback called with `'online'`, `'offline'` or `'reconnecting'`. The UI shows it in the connection status bar.

### Reliability rules

These rules give us no message loss, no duplication, and instant sync after reconnect.

- **Send:** the client generates the `uuid`, shows the bubble immediately as "sending..." (`seq = null`), stores the message in the outbox, then sends it.
- **Ack:** when the server confirms, the message comes back with `seq` filled in. The bubble flips to "sent" and the entry is removed from the outbox.
- **Lost ack or dropped connection:** the outbox is resent on reconnect (or on the next REST attempt) with the **same `uuid`**. The server's UNIQUE constraint on `uuid` keeps one row and returns the existing message, so a retry can never create a second copy.
- **Receive:** every incoming message (live push, sync result, REST poll, history page) goes through one `addMessage()` function. It ignores a `uuid` it already has and keeps the list sorted by `seq`.
- **Catch-up:** the client keeps `lastSeq` (the highest `seq` seen, saved in localStorage). On every connect it calls `sync(lastSeq)`. A live push arriving during the sync is harmless because of the `uuid` dedupe.
- **Server safety:** every socket handler is wrapped in try/catch and payloads are validated, so one bad client can't affect others.

### socket.io events

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `connect` | client to server | `io(url, {auth:{token}})` | JWT in the handshake. The server middleware verifies it; an invalid token gives `connect_error`. On success the socket joins `user:<id>` and `group:<id>` for each membership. |
| `message:send` | client to server | `{uuid, recipient_id \| group_id, body, sent_at}` + ack callback | Sends a message. Ack returns `{ok:true, message}` or `{ok:false, error}`. The same `uuid` sent again returns the same message. |
| `message:new` | server to client | `{message}` | Live push. Delivered to room `user:<recipient>` and `user:<sender>` (so the sender's other devices update), or to `group:<id>`. |
| `sync:request` | client to server | `{after_seq}` + ack callback | Catch-up. Ack returns `{messages:[...]}`. The client sends it on every `connect` event, including the first. |
| `group:created` | server to client | `{group}` | Sent to each member's `user:<id>` room; their sockets also join `group:<id>` immediately. |
| `error:notice` | server to client | `{code, message}` | Non-fatal problems (e.g. a malformed payload). Never crashes the connection. |