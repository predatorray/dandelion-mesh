# <img src="https://github.com/predatorray/dandelion-mesh/blob/assets/Dandelion_40x40.png?raw=true" alt="Description of image" width="40" height="40"> Dandelion Mesh

[![License](https://img.shields.io/github/license/predatorray/dandelion-mesh)](LICENSE)
[![Build Status](https://img.shields.io/github/actions/workflow/status/predatorray/dandelion-mesh/ci.yml?branch=main)](https://github.com/predatorray/dandelion-mesh/actions)
[![codecov](https://codecov.io/github/predatorray/dandelion-mesh/graph/badge.svg?token=KqwNV13MD4)](https://codecov.io/github/predatorray/dandelion-mesh)
![NPM Version](https://img.shields.io/badge/npm-not_published-blue)

Serverless mesh network for browsers using WebRTC.

***Connect***, ***Broadcast***, and ***Sync State*** without a central server.

## Overview

`dandelion-mesh` is a fault-tolerant P2P service mesh library for browser applications.

It combines:
- WebRTC data channels for transport,
- RSA hybrid encryption for private messaging,
- and the Raft consensus algorithm for leader election and ordered log replication

All without requiring a dedicated server.

## Usage

### Install

```bash
npm install dandelion-mesh # not published yet
```

### Basic example

```ts
import { PeerJSTransport, DandelionMesh } from 'dandelion-mesh';

// Create a transport and mesh instance
const transport = new PeerJSTransport({ peerId: 'alice' });
const mesh = new DandelionMesh(transport, {
  bootstrapPeers: ['bob', 'charlie'],
});

// Listen for events
mesh.on('ready', (id) => {
  console.log('My peer ID:', id);
});

mesh.on('message', (msg) => {
  if (msg.type === 'public') {
    console.log(`[${msg.sender}]: ${JSON.stringify(msg.data)}`);
  }
  if (msg.type === 'private') {
    console.log(`[private from ${msg.sender}]: ${JSON.stringify(msg.data)}`);
  }
});

mesh.on('leaderChanged', (leaderId) => {
  console.log('Current leader:', leaderId);
});

mesh.on('peersChanged', (peers) => {
  console.log('Connected peers:', peers);
});

// Send messages
await mesh.sendPublic({ action: 'bet', amount: 100 });
await mesh.sendPrivate('bob', { cards: ['Ah', 'Kd'] });
```

### Using localStorage for durable sessions

```ts
import {
  PeerJSTransport,
  DandelionMesh,
  LocalStorageRaftLog,
} from 'dandelion-mesh';

const transport = new PeerJSTransport({ peerId: 'alice' });
const mesh = new DandelionMesh(transport, {
  bootstrapPeers: ['bob', 'charlie'],
  raftLog: new LocalStorageRaftLog('my-game-room'),
});

// Raft state (term, votedFor, log) persists across page refreshes,
// allowing a peer to rejoin and catch up from where it left off.
```

### Custom transport

```ts
import { Transport, DandelionMesh } from 'dandelion-mesh';

class MyWebSocketTransport implements Transport {
  // Implement the Transport interface with your own
  // connection management and message passing logic.
  // ...
}

const transport = new MyWebSocketTransport();
const mesh = new DandelionMesh(transport);
```

## High-level architecture

```mermaid
graph TB
    subgraph "dandelion-mesh"
        direction TB
        API["DandelionMesh API<br/><i>sendPublic() · sendPrivate() · on('message')</i>"]

        subgraph layers [" "]
            direction LR
            RAFT["Raft Consensus<br/><i>Leader Election<br/>Log Replication</i>"]
            CRYPTO["Crypto Service<br/><i>RSA-OAEP + AES-GCM<br/>Hybrid Encryption</i>"]
        end

        TRANSPORT["Transport Layer<br/><i>PeerJS (default) · pluggable</i>"]
    end

    API --> RAFT
    API --> CRYPTO
    CRYPTO --> RAFT
    RAFT --> TRANSPORT
    TRANSPORT <-->|WebRTC<br/>Data Channels| TRANSPORT
```

## Low-level architecture

### Message flow

```mermaid
sequenceDiagram
    participant App as Application
    participant Mesh as DandelionMesh
    participant Raft as Raft Leader
    participant Peers as Other Peers

    Note over App,Peers: Public message
    App->>Mesh: sendPublic(data)
    Mesh->>Raft: propose(PublicMessageEntry)
    Raft->>Peers: AppendEntries (log replication)
    Peers-->>Raft: success (majority)
    Raft->>Mesh: committed
    Mesh->>App: on('message', PublicMessage)
    Raft->>Peers: leaderCommit updated
    Note over Peers: Each peer applies & emits 'message'

    Note over App,Peers: Private message
    App->>Mesh: sendPrivate(recipientId, data)
    Mesh->>Mesh: encrypt with recipient's RSA public key
    Mesh->>Raft: propose(EncryptedPrivateMessage)
    Raft->>Peers: AppendEntries (encrypted payload in log)
    Peers-->>Raft: success (majority)
    Note over Peers: Only recipient can decrypt
```

### Leader election

```mermaid
stateDiagram-v2
    [*] --> Follower
    Follower --> Candidate: election timeout<br/>(no heartbeat received)
    Candidate --> Leader: received votes<br/>from majority
    Candidate --> Candidate: election timeout<br/>(split vote)
    Candidate --> Follower: discovered higher term<br/>or current leader
    Leader --> Follower: discovered higher term
    Leader --> Leader: sends heartbeats<br/>to prevent elections
```

### Key Design Decisions

- **Transport abstraction** — The `Transport` interface decouples the mesh from PeerJS. Any P2P transport (WebSocket, libp2p, etc.) can be plugged in by implementing the interface.

- **Raft consensus** — Full implementation per the [Raft paper](https://raft.github.io/raft.pdf):
  - Leader election with randomized timeouts (150–300ms default)
  - Log replication with AppendEntries consistency checks
  - Commitment only for current-term entries (Figure 8 safety)
  - Dynamic membership updates as peers join/leave

- **Two log backends** — `InMemoryRaftLog` for ephemeral sessions, `LocalStorageRaftLog` for peers that need to survive page refreshes and rejoin.

- **Hybrid encryption** — Private messages use RSA-OAEP to wrap a random AES-256-GCM key. Public keys are exchanged as Raft log entries, so every peer receives them through the same ordered replication path. All peers see the encrypted log entry, but only the intended recipient can decrypt it.

- **Ordered delivery via Raft** — All messages (public and encrypted private) go through Raft as log entries. Non-leader peers forward proposals to the leader. Once committed, public messages are delivered to all; encrypted messages are decrypted only by the intended recipient. This guarantees total ordering of all events across the cluster.

## Support & Bug Report

If you find any bugs or have suggestions, please feel free to [open an issue](https://github.com/predatorray/dandelion-mesh/issues/new).

## License

This project is licensed under the [MIT License](LICENSE).
