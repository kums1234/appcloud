#!/bin/bash
# create-demo.sh
# Creates a demo application landscape with multiple applications, components, and infrastructure
# for live demonstrations of the AppCloud platform

set -euo pipefail

# Configuration
API_BASE="${API_BASE:-http://localhost:3000}"
APPCLOUD_API_KEY="${APPCLOUD_API_KEY:-}"  # Optional - set if authentication is enabled

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}▶${NC}  $*" >&2; }
success() { echo -e "${GREEN}✓${NC}  $*" >&2; }
warn() { echo -e "${YELLOW}⚠${NC}  $*" >&2; }
error() { echo -e "${RED}✗${NC}  $*" >&2; }

# Check if API key is provided
if [ -z "$APPCLOUD_API_KEY" ]; then
    warn "APPCLOUD_API_KEY not set — assuming authentication is disabled"
else
    log "Using API key for authentication"
fi

# Helper function to make API calls. The X-API-Key header is only added
# when APPCLOUD_API_KEY is set, so the same helper works against dev
# instances running without auth.
api_call() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    if [ "$method" = "GET" ]; then
        curl -s ${APPCLOUD_API_KEY:+-H "X-API-Key: $APPCLOUD_API_KEY"} "$API_BASE$endpoint"
    else
        curl -s -X "$method" -H "Content-Type: application/json" ${APPCLOUD_API_KEY:+-H "X-API-Key: $APPCLOUD_API_KEY"} -d "$data" "$API_BASE$endpoint"
    fi
}

# Create infrastructure resources
create_infra() {
    log "Creating infrastructure resources..."

    # AWS Resources
    api_call "POST" "/infra" '{
        "name": "demo-web-server",
        "provider": "aws",
        "resource_type": "ec2",
        "region": "us-east-1",
        "public": true
    }' > /dev/null && success "Created AWS EC2 instance"

    api_call "POST" "/infra" '{
        "name": "demo-rds-database",
        "provider": "aws",
        "resource_type": "rds",
        "region": "us-east-1",
        "public": false
    }' > /dev/null && success "Created AWS RDS database"

    api_call "POST" "/infra" '{
        "name": "demo-s3-storage",
        "provider": "aws",
        "resource_type": "s3",
        "region": "us-east-1",
        "public": true
    }' > /dev/null && success "Created AWS S3 bucket"

    # Azure Resources
    api_call "POST" "/infra" '{
        "name": "demo-aks-cluster",
        "provider": "azure",
        "resource_type": "aks",
        "region": "East US",
        "public": false
    }' > /dev/null && success "Created Azure AKS cluster"

    api_call "POST" "/infra" '{
        "name": "demo-storage-account",
        "provider": "azure",
        "resource_type": "storage",
        "region": "East US",
        "public": true
    }' > /dev/null && success "Created Azure Storage Account"

    # GCP Resources
    api_call "POST" "/infra" '{
        "name": "demo-gke-cluster",
        "provider": "gcp",
        "resource_type": "gke",
        "region": "us-central1",
        "public": false
    }' > /dev/null && success "Created GCP GKE cluster"

    api_call "POST" "/infra" '{
        "name": "demo-cloud-storage",
        "provider": "gcp",
        "resource_type": "storage",
        "region": "us-central1",
        "public": true
    }' > /dev/null && success "Created GCP Cloud Storage"
}

# Create applications
create_applications() {
    log "Creating applications..."

    # E-commerce Application (Tier 1 - Critical)
    ECOMMERCE_ID=$(api_call "POST" "/applications" '{
        "name": "E-Commerce Platform",
        "tier": 1,
        "owner": "platform-team",
        "environment": "production",
        "availability": "99.9",
        "confidentiality": "confidential",
        "domain": "ecommerce"
    }' | jq -r '.id') && success "Created E-Commerce Platform application"

    # Payment Service Application (Tier 1 - Critical)
    PAYMENT_ID=$(api_call "POST" "/applications" '{
        "name": "Payment Service",
        "tier": 1,
        "owner": "payments-team",
        "environment": "production",
        "availability": "99.999",
        "confidentiality": "restricted",
        "domain": "payments"
    }' | jq -r '.id') && success "Created Payment Service application"

    # User Management Application (Tier 2 - High)
    USER_MGMT_ID=$(api_call "POST" "/applications" '{
        "name": "User Management",
        "tier": 2,
        "owner": "identity-team",
        "environment": "production",
        "availability": "99.9",
        "confidentiality": "confidential",
        "domain": "identity"
    }' | jq -r '.id') && success "Created User Management application"

    # Analytics Application (Tier 3 - Medium)
    ANALYTICS_ID=$(api_call "POST" "/applications" '{
        "name": "Analytics Dashboard",
        "tier": 3,
        "owner": "data-team",
        "environment": "staging",
        "availability": "99",
        "confidentiality": "internal",
        "domain": "analytics"
    }' | jq -r '.id') && success "Created Analytics Dashboard application"

    # Notification Service (Tier 2 - High)
    NOTIFICATION_ID=$(api_call "POST" "/applications" '{
        "name": "Notification Service",
        "tier": 2,
        "owner": "platform-team",
        "environment": "production",
        "availability": "99.9",
        "confidentiality": "internal",
        "domain": "messaging"
    }' | jq -r '.id') && success "Created Notification Service application"

    echo "$ECOMMERCE_ID $PAYMENT_ID $USER_MGMT_ID $ANALYTICS_ID $NOTIFICATION_ID"
}

# Create components for applications
create_components() {
    local app_ids="$1"
    read -r ECOMMERCE_ID PAYMENT_ID USER_MGMT_ID ANALYTICS_ID NOTIFICATION_ID <<< "$app_ids"

    log "Creating components..."

    # E-Commerce Components
    api_call "POST" "/components" "{
        \"name\": \"web-frontend\",
        \"type\": \"UI\",
        \"runtime\": \"react18\",
        \"applicationId\": \"$ECOMMERCE_ID\"
    }" > /dev/null && success "Created web-frontend component"

    api_call "POST" "/components" "{
        \"name\": \"api-gateway\",
        \"type\": \"API\",
        \"runtime\": \"nodejs18\",
        \"applicationId\": \"$ECOMMERCE_ID\"
    }" > /dev/null && success "Created api-gateway component"

    api_call "POST" "/components" "{
        \"name\": \"order-service\",
        \"type\": \"Service\",
        \"runtime\": \"java17\",
        \"applicationId\": \"$ECOMMERCE_ID\"
    }" > /dev/null && success "Created order-service component"

    api_call "POST" "/components" "{
        \"name\": \"inventory-service\",
        \"type\": \"Service\",
        \"runtime\": \"python3.11\",
        \"applicationId\": \"$ECOMMERCE_ID\"
    }" > /dev/null && success "Created inventory-service component"

    # Payment Service Components
    api_call "POST" "/components" "{
        \"name\": \"payment-api\",
        \"type\": \"API\",
        \"runtime\": \"golang1.19\",
        \"applicationId\": \"$PAYMENT_ID\"
    }" > /dev/null && success "Created payment-api component"

    api_call "POST" "/components" "{
        \"name\": \"fraud-detection\",
        \"type\": \"Service\",
        \"runtime\": \"python3.11\",
        \"applicationId\": \"$PAYMENT_ID\"
    }" > /dev/null && success "Created fraud-detection component"

    # User Management Components
    api_call "POST" "/components" "{
        \"name\": \"auth-service\",
        \"type\": \"Service\",
        \"runtime\": \"nodejs18\",
        \"applicationId\": \"$USER_MGMT_ID\"
    }" > /dev/null && success "Created auth-service component"

    api_call "POST" "/components" "{
        \"name\": \"user-api\",
        \"type\": \"API\",
        \"runtime\": \"java17\",
        \"applicationId\": \"$USER_MGMT_ID\"
    }" > /dev/null && success "Created user-api component"

    # Analytics Components
    api_call "POST" "/components" "{
        \"name\": \"analytics-api\",
        \"type\": \"API\",
        \"runtime\": \"python3.11\",
        \"applicationId\": \"$ANALYTICS_ID\"
    }" > /dev/null && success "Created analytics-api component"

    api_call "POST" "/components" "{
        \"name\": \"data-processor\",
        \"type\": \"Worker\",
        \"runtime\": \"python3.11\",
        \"applicationId\": \"$ANALYTICS_ID\"
    }" > /dev/null && success "Created data-processor component"

    # Notification Service Components
    api_call "POST" "/components" "{
        \"name\": \"email-service\",
        \"type\": \"Service\",
        \"runtime\": \"nodejs18\",
        \"applicationId\": \"$NOTIFICATION_ID\"
    }" > /dev/null && success "Created email-service component"

    api_call "POST" "/components" "{
        \"name\": \"sms-service\",
        \"type\": \"Service\",
        \"runtime\": \"golang1.19\",
        \"applicationId\": \"$NOTIFICATION_ID\"
    }" > /dev/null && success "Created sms-service component"
}

# Create connections between components
create_connections() {
    log "Creating component connections..."

    # Get component IDs
    COMPONENTS=$(api_call "GET" "/components")
    WEB_FRONTEND_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "web-frontend") | .id')
    API_GATEWAY_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "api-gateway") | .id')
    ORDER_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "order-service") | .id')
    INVENTORY_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "inventory-service") | .id')
    PAYMENT_API_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "payment-api") | .id')
    FRAUD_DETECTION_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "fraud-detection") | .id')
    AUTH_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "auth-service") | .id')
    USER_API_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "user-api") | .id')
    ANALYTICS_API_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "analytics-api") | .id')
    DATA_PROCESSOR_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "data-processor") | .id')
    EMAIL_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "email-service") | .id')
    SMS_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "sms-service") | .id')

    # Intra-application connections (E-Commerce)
    api_call "POST" "/components/$WEB_FRONTEND_ID/connections" "{
        \"targetId\": \"$API_GATEWAY_ID\",
        \"protocol\": \"HTTPS\",
        \"port\": 443
    }" > /dev/null && success "Connected web-frontend → api-gateway"

    api_call "POST" "/components/$API_GATEWAY_ID/connections" "{
        \"targetId\": \"$ORDER_SERVICE_ID\",
        \"protocol\": \"HTTP\",
        \"port\": 8080
    }" > /dev/null && success "Connected api-gateway → order-service"

    api_call "POST" "/components/$ORDER_SERVICE_ID/connections" "{
        \"targetId\": \"$INVENTORY_SERVICE_ID\",
        \"protocol\": \"gRPC\",
        \"port\": 9090
    }" > /dev/null && success "Connected order-service → inventory-service"

    # Inter-application connections
    api_call "POST" "/components/$ORDER_SERVICE_ID/connections" "{
        \"targetId\": \"$PAYMENT_API_ID\",
        \"protocol\": \"HTTPS\",
        \"port\": 443
    }" > /dev/null && success "Connected order-service → payment-api (cross-app)"

    api_call "POST" "/components/$PAYMENT_API_ID/connections" "{
        \"targetId\": \"$FRAUD_DETECTION_ID\",
        \"protocol\": \"TCP\",
        \"port\": 6379
    }" > /dev/null && success "Connected payment-api → fraud-detection"

    api_call "POST" "/components/$WEB_FRONTEND_ID/connections" "{
        \"targetId\": \"$AUTH_SERVICE_ID\",
        \"protocol\": \"HTTPS\",
        \"port\": 443
    }" > /dev/null && success "Connected web-frontend → auth-service (cross-app)"

    api_call "POST" "/components/$API_GATEWAY_ID/connections" "{
        \"targetId\": \"$USER_API_ID\",
        \"protocol\": \"HTTP\",
        \"port\": 8080
    }" > /dev/null && success "Connected api-gateway → user-api (cross-app)"

    # Analytics connections
    api_call "POST" "/components/$ORDER_SERVICE_ID/connections" "{
        \"targetId\": \"$ANALYTICS_API_ID\",
        \"protocol\": \"HTTPS\",
        \"port\": 443
    }" > /dev/null && success "Connected order-service → analytics-api (cross-app)"

    api_call "POST" "/components/$PAYMENT_API_ID/connections" "{
        \"targetId\": \"$ANALYTICS_API_ID\",
        \"protocol\": \"HTTPS\",
        \"port\": 443
    }" > /dev/null && success "Connected payment-api → analytics-api (cross-app)"

    # Notification connections
    api_call "POST" "/components/$ORDER_SERVICE_ID/connections" "{
        \"targetId\": \"$EMAIL_SERVICE_ID\",
        \"protocol\": \"AMQP\",
        \"port\": 5672
    }" > /dev/null && success "Connected order-service → email-service (cross-app)"

    api_call "POST" "/components/$PAYMENT_API_ID/connections" "{
        \"targetId\": \"$SMS_SERVICE_ID\",
        \"protocol\": \"AMQP\",
        \"port\": 5672
    }" > /dev/null && success "Connected payment-api → sms-service (cross-app)"
}

# Deploy components to infrastructure
create_deployments() {
    log "Creating component deployments..."

    # Get component and infra IDs
    COMPONENTS=$(api_call "GET" "/components")
    INFRA=$(api_call "GET" "/infra")

    WEB_FRONTEND_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "web-frontend") | .id')
    API_GATEWAY_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "api-gateway") | .id')
    ORDER_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "order-service") | .id')
    INVENTORY_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "inventory-service") | .id')
    PAYMENT_API_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "payment-api") | .id')
    FRAUD_DETECTION_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "fraud-detection") | .id')
    AUTH_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "auth-service") | .id')
    USER_API_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "user-api") | .id')
    ANALYTICS_API_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "analytics-api") | .id')
    DATA_PROCESSOR_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "data-processor") | .id')
    EMAIL_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "email-service") | .id')
    SMS_SERVICE_ID=$(echo "$COMPONENTS" | jq -r '.[] | select(.name == "sms-service") | .id')

    WEB_SERVER_ID=$(echo "$INFRA" | jq -r '.[] | select(.name == "demo-web-server") | .id')
    RDS_ID=$(echo "$INFRA" | jq -r '.[] | select(.name == "demo-rds-database") | .id')
    S3_ID=$(echo "$INFRA" | jq -r '.[] | select(.name == "demo-s3-storage") | .id')
    AKS_ID=$(echo "$INFRA" | jq -r '.[] | select(.name == "demo-aks-cluster") | .id')
    AZURE_STORAGE_ID=$(echo "$INFRA" | jq -r '.[] | select(.name == "demo-storage-account") | .id')
    GKE_ID=$(echo "$INFRA" | jq -r '.[] | select(.name == "demo-gke-cluster") | .id')
    GCP_STORAGE_ID=$(echo "$INFRA" | jq -r '.[] | select(.name == "demo-cloud-storage") | .id')

    # Deploy web frontend to AWS EC2
    api_call "POST" "/components/$WEB_FRONTEND_ID/deploy" "{\"infraId\": \"$WEB_SERVER_ID\"}" > /dev/null && success "Deployed web-frontend to AWS EC2"

    # Deploy API gateway to AWS EC2
    api_call "POST" "/components/$API_GATEWAY_ID/deploy" "{\"infraId\": \"$WEB_SERVER_ID\"}" > /dev/null && success "Deployed api-gateway to AWS EC2"

    # Deploy services to different infrastructure
    api_call "POST" "/components/$ORDER_SERVICE_ID/deploy" "{\"infraId\": \"$AKS_ID\"}" > /dev/null && success "Deployed order-service to Azure AKS"
    api_call "POST" "/components/$INVENTORY_SERVICE_ID/deploy" "{\"infraId\": \"$AKS_ID\"}" > /dev/null && success "Deployed inventory-service to Azure AKS"

    api_call "POST" "/components/$PAYMENT_API_ID/deploy" "{\"infraId\": \"$GKE_ID\"}" > /dev/null && success "Deployed payment-api to GCP GKE"
    api_call "POST" "/components/$FRAUD_DETECTION_ID/deploy" "{\"infraId\": \"$GKE_ID\"}" > /dev/null && success "Deployed fraud-detection to GCP GKE"

    api_call "POST" "/components/$AUTH_SERVICE_ID/deploy" "{\"infraId\": \"$WEB_SERVER_ID\"}" > /dev/null && success "Deployed auth-service to AWS EC2"
    api_call "POST" "/components/$USER_API_ID/deploy" "{\"infraId\": \"$WEB_SERVER_ID\"}" > /dev/null && success "Deployed user-api to AWS EC2"

    api_call "POST" "/components/$ANALYTICS_API_ID/deploy" "{\"infraId\": \"$AKS_ID\"}" > /dev/null && success "Deployed analytics-api to Azure AKS"
    api_call "POST" "/components/$DATA_PROCESSOR_ID/deploy" "{\"infraId\": \"$AKS_ID\"}" > /dev/null && success "Deployed data-processor to Azure AKS"

    api_call "POST" "/components/$EMAIL_SERVICE_ID/deploy" "{\"infraId\": \"$GKE_ID\"}" > /dev/null && success "Deployed email-service to GCP GKE"
    api_call "POST" "/components/$SMS_SERVICE_ID/deploy" "{\"infraId\": \"$GKE_ID\"}" > /dev/null && success "Deployed sms-service to GCP GKE"

    # Deploy databases and storage
    api_call "POST" "/components/$ORDER_SERVICE_ID/deploy" "{\"infraId\": \"$RDS_ID\"}" > /dev/null && success "Deployed order-service to AWS RDS"
    api_call "POST" "/components/$INVENTORY_SERVICE_ID/deploy" "{\"infraId\": \"$RDS_ID\"}" > /dev/null && success "Deployed inventory-service to AWS RDS"
    api_call "POST" "/components/$PAYMENT_API_ID/deploy" "{\"infraId\": \"$RDS_ID\"}" > /dev/null && success "Deployed payment-api to AWS RDS"

    api_call "POST" "/components/$ANALYTICS_API_ID/deploy" "{\"infraId\": \"$S3_ID\"}" > /dev/null && success "Deployed analytics-api to AWS S3"
    api_call "POST" "/components/$DATA_PROCESSOR_ID/deploy" "{\"infraId\": \"$AZURE_STORAGE_ID\"}" > /dev/null && success "Deployed data-processor to Azure Storage"
}

# Main execution
main() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    AppCloud Demo Setup                        ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    log "Starting demo data creation..."
    echo "API Base: $API_BASE"
    echo ""

    create_infra
    echo ""
    APP_IDS=$(create_applications)
    echo ""
    create_components "$APP_IDS"
    echo ""
    create_connections
    echo ""
    create_deployments
    echo ""

    success "Demo setup complete!"
    echo ""
    echo "Created:"
    echo "  • 5 Applications (E-Commerce, Payment, User Mgmt, Analytics, Notifications)"
    echo "  • 13 Components across all applications"
    echo "  • 15 Component connections (intra and inter-application)"
    echo "  • 7 Infrastructure resources (AWS, Azure, GCP)"
    echo "  • 20+ Component-to-infrastructure deployments"
    echo ""
    warn "To clean up, run: ./delete-demo.sh"
}

main "$@"