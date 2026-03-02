# Neo4j Infrastructure Graph API

Fastify REST API for querying and managing an infrastructure graph in Neo4j.

## Setup

```bash
npm install
cp .env.example .env   # fill in your Neo4j credentials
npm run dev            # development with auto-reload
npm start              # production
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j Bolt URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | `yourpassword` | Neo4j password |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |

---

## API Reference

### Applications — `/applications`

| Method | Path | Description |
|---|---|---|
| GET | `/applications` | List all applications |
| GET | `/applications/:id` | Get application with components + infra |
| POST | `/applications` | Create application |
| PATCH | `/applications/:id` | Update application |
| DELETE | `/applications/:id` | Delete application |
| GET | `/applications/:id/topology` | Full topology with connections |
| GET | `/applications/:id/dependencies` | Cross-app dependencies |

**POST /applications body:**
```json
{
  "name": "Payment Service",
  "tier": 1,
  "owner": "platform-team",
  "environment": "production"
}
```

---

### Components — `/components`

| Method | Path | Description |
|---|---|---|
| GET | `/components?type=API` | List components (optional type filter) |
| GET | `/components/:id` | Get component with inbound/outbound connections |
| POST | `/components` | Create component |
| PATCH | `/components/:id` | Update component |
| DELETE | `/components/:id` | Delete component |
| POST | `/components/:id/connections` | Add CONNECTS_TO edge |
| DELETE | `/components/:id/connections/:targetId` | Remove connection |
| POST | `/components/:id/deploy` | Link component to Infra |

**POST /components body:**
```json
{
  "name": "payments-api",
  "type": "API",
  "runtime": "node18",
  "applicationId": "<uuid>"
}
```

**POST /components/:id/connections body:**
```json
{
  "targetId": "<component-uuid>",
  "protocol": "HTTPS",
  "port": 443
}
```

---

### Infra — `/infra`

| Method | Path | Description |
|---|---|---|
| GET | `/infra?provider=aws&public=true` | List infra (filterable) |
| GET | `/infra/:id` | Get infra with deployments + network connections |
| POST | `/infra` | Create infra resource |
| PATCH | `/infra/:id` | Update infra resource |
| DELETE | `/infra/:id` | Delete infra resource |
| POST | `/infra/:id/network-connections` | Add NETWORK_CONNECTS edge |
| GET | `/infra/shared/resources` | Infra used by multiple apps |
| GET | `/infra/public/exposed` | All public-facing infra |

---

### Changes — `/changes`

| Method | Path | Description |
|---|---|---|
| GET | `/changes?status=draft` | List changes (optional status filter) |
| GET | `/changes/:id` | Get change with full approval history |
| POST | `/changes` | Submit new change |
| POST | `/changes/:id/approve` | Approve a draft change |
| POST | `/changes/:id/reject` | Reject a draft change |
| GET | `/changes/:id/blast-radius` | Everything the change touches |
| GET | `/changes/risk/high?threshold=7.0` | High risk approved changes |

**POST /changes body:**
```json
{
  "description": "Upgrade payments-api to node20",
  "riskScore": 7.4,
  "submittedBy": "<user-uuid>",
  "modifiesIds": ["<component-uuid>", "<infra-uuid>"],
  "affectsIds": ["<application-uuid>"]
}
```

**POST /changes/:id/approve body:**
```json
{ "userId": "<user-uuid>" }
```

**POST /changes/:id/reject body:**
```json
{ "userId": "<user-uuid>", "reason": "Security policy violation" }
```

---

### Users — `/users`

| Method | Path | Description |
|---|---|---|
| GET | `/users` | List all users |
| GET | `/users/:id` | Get user with activity summary |
| POST | `/users` | Create user |
| PATCH | `/users/:id` | Update user |
| GET | `/users/:id/changes` | All changes a user submitted/approved/rejected |

---

### Graph — `/graph`

| Method | Path | Description |
|---|---|---|
| GET | `/graph/summary` | Node counts and high-level stats |
| GET | `/graph/path?from=id&to=id` | Shortest path between two components |
| GET | `/graph/cross-app-dependencies` | All cross-application connections |
| GET | `/graph/impact?infraId=id` | What breaks if this infra goes down |
| GET | `/graph/snapshots` | List snapshots |
| POST | `/graph/snapshots` | Create a new snapshot |

---

## Docker Compose (Neo4j + API)

```yaml
version: '3.8'
services:
  neo4j:
    image: neo4j:5.18-community
    ports:
      - "7474:7474"
      - "7687:7687"
    environment:
      - NEO4J_AUTH=neo4j/yourpassword
    volumes:
      - neo4j_data:/data

  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NEO4J_URI=bolt://neo4j:7687
      - NEO4J_USER=neo4j
      - NEO4J_PASSWORD=yourpassword
    depends_on:
      - neo4j

volumes:
  neo4j_data:
```
