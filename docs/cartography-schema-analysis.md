# Cartography Schema Analysis & Comparison with AppCloud

## 1. Cartography Schema — Full Architecture

```
                         CARTOGRAPHY SCHEMA OVERVIEW
  ============================================================================

  ONTOLOGY LAYER (cross-platform semantic labels)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Tenant          UserAccount       UserGroup        APIKey     Device   │
  │  (AWSAccount,    (OktaUser,        (AWSGroup,       (Anthro-   (Intune │
  │   AzureTenant,    EntraUser,        EntraGroup,      picKey,    Kandji  │
  │   GCPOrg)         AirbyteUser)      GoogleGroup)     OpenAI)    Tail.)  │
  └──────────────────────────────────────────────────────────────────────────┘
       Every node gets a semantic "extra label" for cross-cloud queries
       e.g. AzureTenant also has label :Tenant
       e.g. AWSUser also has label :UserAccount

  ═══════════════════════════════════════════════════════════════════════════

  AZURE RESOURCE HIERARCHY
  ════════════════════════

  AzureTenant ──[:RESOURCE]──> AzureSubscription
       │                              │
       │                    ┌─────────┼──────────────────────────────────┐
       │                    │         │                                  │
       │              [:RESOURCE] [:RESOURCE]                      [:RESOURCE]
       │                    │         │                                  │
       │                    ▼         ▼                                  ▼
       │          AzureResourceGroup                            AzureRoleDefinition
       │                    │                                           │
       │         ┌──────────┼──────────────────────┐          [:HAS_PERMISSION]
       │         │          │                      │                    │
       │    [:RESOURCE] [:RESOURCE]           [:RESOURCE]               ▼
       │         │          │                      │          AzureRoleAssignment
       │         ▼          ▼                      ▼             │
       │    ┌─────────┐ ┌──────────┐        ┌──────────┐   [:HAS_ROLE_ASSIGNMENT]
       │    │ Virtual  │ │ AzureSQL │        │  Azure   │        │
       │    │ Machine  │ │ Server   │        │ Storage  │        ▼
       │    └────┬─────┘ └────┬─────┘        │ Account  │   AzurePrincipal
       │         │            │              └──────────┘
       │    [:ATTACHED]  [:RESOURCE]
       │         │            │
       │         ▼            ▼
       │    AzureDisk   AzureSQLDatabase
       │
       [:RESOURCE]
            │
            ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  COMPUTE            NETWORK            DATA              SECURITY  │
  │  ────────           ───────            ────              ────────  │
  │  VirtualMachine     AzureVNet          AzureSQLServer    AzureKV   │
  │  AzureKubCluster    AzureSubnet        AzureSQLDatabase  AzureKV   │
  │  AzureKubAgentPool  AzureNSG           AzureCosmosDB      Secret   │
  │  AzureAppService    AzureLoadBalancer  AzureStorage       AzureKV  │
  │  AzureFunctionApp   AzureFirewall      AzureDataFactory    Key     │
  │  AzureContainerApp                     AzureSynapse       AzureKV  │
  │                                                            Cert    │
  └──────────────────────────────────────────────────────────────────────┘


  ═══════════════════════════════════════════════════════════════════════════

  NODE ANATOMY (every single node in Cartography)
  ════════════════════════════════════════════════

  ┌─────────────────────────────────────────────────────────────────┐
  │  :AzureVirtualMachine :ComputeInstance                         │
  │  ─────────────────────────────────────                         │
  │                                                                │
  │  STANDARD PROPERTIES (on ALL nodes):                           │
  │  ┌───────────────┬───────────────────────────────────────────┐  │
  │  │ id            │ Globally unique (ARM ID for Azure)        │  │
  │  │ firstseen     │ Epoch int — when first discovered         │  │
  │  │ lastupdated   │ Epoch int — last sync run timestamp       │  │
  │  └───────────────┴───────────────────────────────────────────┘  │
  │                                                                │
  │  RESOURCE-SPECIFIC PROPERTIES:                                 │
  │  ┌───────────────┬───────────────────────────────────────────┐  │
  │  │ name          │ "my-production-vm"                        │  │
  │  │ location      │ "eastus"                                  │  │
  │  │ resourcegroup │ "rg-production"                           │  │
  │  │ type          │ "Microsoft.Compute/virtualMachines"       │  │
  │  │ size          │ "Standard_D4s_v3"                         │  │
  │  │ license_type  │ "Windows_Server"                          │  │
  │  │ computer_name │ "PROD-WEB-01"                             │  │
  │  │ zones         │ ["1"]                                     │  │
  │  │ priority      │ "Regular"                                 │  │
  │  └───────────────┴───────────────────────────────────────────┘  │
  │                                                                │
  │  ENRICHMENT PROPERTIES (computed by Cartography):              │
  │  ┌───────────────┬───────────────────────────────────────────┐  │
  │  │ exposed_internet │ true/false — public reachability       │  │
  │  │ anonymous_access │ true/false — unauthenticated access    │  │
  │  └───────────────┴───────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────────┘


  ═══════════════════════════════════════════════════════════════════════════

  RELATIONSHIP PATTERNS
  ═════════════════════

  1. OWNERSHIP (hierarchical)
     Tenant ──[:RESOURCE]──> Subscription ──[:RESOURCE]──> VM

  2. STRUCTURAL (infrastructure wiring)
     VM ──[:ATTACHED]──> Disk
     VM ──[:NETWORK_INTERFACE]──> NIC ──[:PART_OF_SUBNET]──> Subnet
     Subnet ──[:MEMBER_OF_VPC]──> VNet
     SecurityGroup ──[:MEMBER_OF_EC2_SECURITY_GROUP]──> Instance

  3. IDENTITY & ACCESS
     Principal ──[:HAS_ROLE_ASSIGNMENT]──> RoleAssignment
     RoleAssignment ──[:HAS_PERMISSION]──> RoleDefinition
     User ──[:MEMBER_AWS_GROUP]──> Group
     Principal ──[:STS_ASSUMEROLE_ALLOW]──> Role

  4. SECURITY FINDINGS
     Instance ──[:HAS_FINDING]──> InspectorFinding
     Image ──[:HAS_FINDING]──> TrivyFinding
     Repo ──[:HAS_FINDING]──> SemgrepFinding

  5. CROSS-PLATFORM (via ontology labels)
     Any :Tenant node can be queried regardless of cloud
     Any :UserAccount node is queryable across Okta, Entra, AWS IAM


  ═══════════════════════════════════════════════════════════════════════════

  STALE DATA CLEANUP (automatic via lastupdated)
  ═══════════════════════════════════════════════

  Every sync run sets lastupdated = current_epoch on touched nodes.
  After sync, nodes where lastupdated < current_epoch are DELETED.
  This means: if a VM is terminated in Azure, the next Cartography
  sync automatically removes it from Neo4j. No manual cleanup needed.

```

## 2. Key Schema Strengths

### A. One Node Label Per Resource Type (not generic)

```
  CARTOGRAPHY                         APPCLOUD (current)
  ───────────                         ──────────────────
  :AzureVirtualMachine                :Infra {resource_type: 'vm'}
  :AzureSQLServer                     :Infra {resource_type: 'sql_server'}
  :AzureKubernetesCluster             :Infra {resource_type: 'aks_cluster'}
  :EC2Instance                        :Infra {resource_type: 'ec2_instance'}
```

**Why this matters:**
- Neo4j indexes on labels are faster than property indexes
- Cypher queries are clearer: `MATCH (v:AzureVirtualMachine)` vs `MATCH (i:Infra {resource_type:'vm'})`
- Each type can have its own properties without nulls
- Schema validation is possible per label

### B. Typed Relationships (not generic)

```
  CARTOGRAPHY                         APPCLOUD (current)
  ───────────                         ──────────────────
  [:ATTACHED]                         [:CONNECTED_TO {via:'disk'}]
  [:NETWORK_INTERFACE]                [:CONNECTED_TO {via:'nic'}]
  [:PART_OF_SUBNET]                   [:CONNECTED_TO {via:'subnet'}]
  [:RESOURCE]                         (no equivalent — flat)
  [:HAS_ROLE_ASSIGNMENT]              (no equivalent)
```

**Why this matters:**
- Cypher traversals can filter by relationship type in the pattern, which is O(1)
- Filtering by property `{via:'nic'}` requires scanning every CONNECTED_TO edge, which is O(n)
- Query: "find all VMs in a subnet" is one pattern match, not a filtered scan

### C. Ontology Labels (cross-cloud abstraction)

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  AzureTenant    also has label    :Tenant                      │
  │  AWSAccount     also has label    :Tenant                      │
  │  GCPOrganization also has label   :Tenant                      │
  │                                                                │
  │  So you can query:  MATCH (t:Tenant) RETURN t                  │
  │  And get ALL tenants across ALL clouds in one query             │
  └─────────────────────────────────────────────────────────────────┘
```

**AppCloud equivalent:** You use `provider` property to distinguish, which works
but requires WHERE clauses for cross-cloud queries.

### D. Automatic Staleness via lastupdated

```
  Sync Run #1 (epoch 1000):
    VM-A.lastupdated = 1000
    VM-B.lastupdated = 1000
    VM-C.lastupdated = 1000

  VM-B gets deleted in Azure...

  Sync Run #2 (epoch 2000):
    VM-A.lastupdated = 2000  (still exists, updated)
    VM-B.lastupdated = 1000  (NOT updated — stale!)
    VM-C.lastupdated = 2000  (still exists, updated)

  Cleanup query:
    MATCH (v:AzureVirtualMachine)
    WHERE v.lastupdated < 2000
    DETACH DELETE v
    → VM-B removed automatically
```

**AppCloud current:** No automatic staleness cleanup. Deleted cloud resources
remain as orphan nodes until manually bulk-deleted.

### E. Properties as First-Class Columns (not JSON blobs)

```
  CARTOGRAPHY                         APPCLOUD (current)
  ───────────                         ──────────────────
  vm.size = "Standard_D4s_v3"         i.raw = '{"vmSize":"Standard_D4s_v3",
  vm.location = "eastus"                       "region":"eastus",
  vm.zones = ["1"]                             "zones":["1"], ...}'
  vm.computer_name = "PROD-01"
                                      → Must JSON.parse(i.raw) to access
                                      → Cannot index or query raw fields
                                      → Cannot use in WHERE clauses
```

**Why this matters:**
- Direct property access is indexable and queryable
- JSON blob requires parsing in application code


## 3. Comparison Diagram

```
  ══════════════════════════════════════════════════════════════════════════
  SCHEMA COMPARISON: CARTOGRAPHY vs APPCLOUD
  ══════════════════════════════════════════════════════════════════════════

  CARTOGRAPHY                          APPCLOUD
  ═══════════                          ════════

  :AzureTenant                         (no equivalent)
       │                                    │
   [:RESOURCE]                              │
       │                                    │
  :AzureSubscription                   (stored in config)
       │                                    │
   [:RESOURCE]                              │
       │                                    │
  :AzureVirtualMachine ─────────────── :Infra {resource_type:'vm'}
  :AzureSQLServer      ─────────────── :Infra {resource_type:'sql_server'}
  :AzureAppService     ─────────────── :Infra {resource_type:'app_service'}
       │                                    │
   [:ATTACHED]                         [:CONNECTED_TO {via:'disk'}]
   [:NETWORK_INTERFACE]                [:CONNECTED_TO {via:'nic'}]
   [:PART_OF_SUBNET]                   [:CONNECTED_TO {via:'subnet'}]
       │                                    │
       │                               [:DEPLOYED_ON]
       │                                    │
  (no equivalent) ─────────────────── :Component
       │                                    │
  (no equivalent) ─────────────────── :Application
       │                                    │
  (no equivalent) ─────────────────── Mapping Suggestions Engine
                                       Scored linking (0-100)
                                       Strategy selection

  ──────────────────────────────────────────────────────────────────────────
  WHAT CARTOGRAPHY HAS              WHAT APPCLOUD HAS
  THAT APPCLOUD DOESN'T             THAT CARTOGRAPHY DOESN'T
  ──────────────────────────────────────────────────────────────────────────
  ✓ Typed node labels per resource  ✓ Application → Component → Infra
  ✓ Typed relationship labels         mapping with scored suggestions
  ✓ Ontology cross-cloud labels     ✓ Linking strategy selection
  ✓ Automatic stale node cleanup    ✓ Tag-driven auto-mapping
  ✓ First-class properties          ✓ Resource Group propagation
  ✓ Identity & access graph         ✓ Bootstrap discovery
  ✓ Security finding nodes          ✓ UI with visual management
  ✓ 30+ source integrations         ✓ Blast radius via enrichment
  ✓ ORM-generated Cypher            ✓ AI-assisted explanation
  ──────────────────────────────────────────────────────────────────────────


  PROPOSED EVOLUTION: BEST OF BOTH
  ══════════════════════════════════

  :AzureTenant ──[:RESOURCE]──> :AzureSubscription
                                       │
                                  [:RESOURCE]
                                       │
                ┌──────────────────────┼──────────────────────┐
                │                      │                      │
        :AzureVM :ComputeInstance  :AzureSQLServer       :AzureAppService
        {                          :DatabaseInstance      :WebService
          id, name, location,      {                     {
          size, zones,               id, name,             id, name,
          firstseen, lastupdated     location,             location,
        }                            firstseen,            firstseen,
                │                    lastupdated            lastupdated
           [:ATTACHED]             }                     }
                │                      │                      │
           :AzureDisk            [:SQL_DATABASE]         [:APP_PLAN]
                                       │                      │
                                 :AzureSQLDB             :AzureAppPlan
                │                      │                      │
                └──────────┬───────────┘──────────────────────┘
                           │
                      [:DEPLOYED_ON]    ← AppCloud's unique value
                           │
                      :Component
                      {name, type}
                           │
                      [:CONTAINS]
                           │
                      :Application
                      {name, tier, owner, env}
                           │
                      Linking Strategy Engine
                      Mapping Suggestions
                      Scored Auto-Mapping
```

## 4. Recommended Schema Evolution Steps

### Phase 1 — Quick Wins (no breaking changes)
1. Add `firstseen` property to all `:Infra` nodes
2. Implement `lastupdated`-based stale cleanup after each scan
3. Promote key `raw` JSON fields to top-level properties (size, location, zones)

### Phase 2 — Typed Relationships
1. Replace `[:CONNECTED_TO {via:'nic'}]` with `[:NETWORK_INTERFACE]`
2. Replace `[:CONNECTED_TO {via:'subnet'}]` with `[:PART_OF_SUBNET]`
3. Replace `[:CONNECTED_TO {via:'disk'}]` with `[:ATTACHED]`
4. Keep `[:DEPLOYED_ON]` and `[:CONTAINS]` — these are AppCloud's unique value

### Phase 3 — Typed Node Labels (bigger migration)
1. Add specific labels alongside `:Infra` (e.g., `:Infra:AzureVM`)
2. Add ontology labels (`:ComputeInstance`, `:DatabaseInstance`)
3. Gradually query by specific label instead of `resource_type` property
4. Add `:AzureTenant` and `:AzureSubscription` hierarchy nodes

### Phase 4 — ORM Layer
1. Define node schemas declaratively (like Cartography's CartographyNodeSchema)
2. Auto-generate Cypher from schema definitions
3. Auto-cleanup stale nodes based on lastupdated
