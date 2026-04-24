#!/bin/bash
# delete-demo.sh
# Deletes all demo applications, components, and infrastructure created by create-demo.sh
# for cleaning up after live demonstrations

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
    local data="${3:-}"

    if [ "$method" = "GET" ]; then
        curl -s ${APPCLOUD_API_KEY:+-H "X-API-Key: $APPCLOUD_API_KEY"} "$API_BASE$endpoint"
    elif [ "$method" = "DELETE" ]; then
        curl -s -X DELETE ${APPCLOUD_API_KEY:+-H "X-API-Key: $APPCLOUD_API_KEY"} "$API_BASE$endpoint"
    else
        curl -s -X "$method" -H "Content-Type: application/json" ${APPCLOUD_API_KEY:+-H "X-API-Key: $APPCLOUD_API_KEY"} -d "$data" "$API_BASE$endpoint"
    fi
}

# Delete all demo applications (this will cascade delete components and infra)
delete_applications() {
    log "Deleting demo applications..."

    # Get all applications
    APPS=$(api_call "GET" "/applications")

    # Filter for demo applications
    DEMO_APPS=$(echo "$APPS" | jq -r '.[] | select(.name | test("^(E-Commerce Platform|Payment Service|User Management|Analytics Dashboard|Notification Service)$")) | .id')

    if [ -z "$DEMO_APPS" ]; then
        warn "No demo applications found to delete"
        return
    fi

    # Delete each demo application
    echo "$DEMO_APPS" | while read -r app_id; do
        if [ -n "$app_id" ]; then
            APP_NAME=$(echo "$APPS" | jq -r ".[] | select(.id == \"$app_id\") | .name")
            api_call "DELETE" "/applications/$app_id" > /dev/null && success "Deleted application: $APP_NAME"
        fi
    done
}

# Clean up any orphaned components (components not belonging to any application)
cleanup_orphaned_components() {
    log "Checking for orphaned components..."

    # Get all components
    COMPONENTS=$(api_call "GET" "/components")

    # Find components that don't have an application
    ORPHANED=$(echo "$COMPONENTS" | jq -r '.[] | select(.applicationId == null and .application == null) | .id')

    if [ -z "$ORPHANED" ]; then
        success "No orphaned components found"
        return
    fi

    warn "Found orphaned components, cleaning up..."
    echo "$ORPHANED" | while read -r comp_id; do
        if [ -n "$comp_id" ]; then
            COMP_NAME=$(echo "$COMPONENTS" | jq -r ".[] | select(.id == \"$comp_id\") | .name")
            api_call "DELETE" "/components/$comp_id" > /dev/null && success "Deleted orphaned component: $COMP_NAME"
        fi
    done
}

# Clean up any orphaned infrastructure (infra not used by any components)
cleanup_orphaned_infra() {
    log "Checking for orphaned infrastructure..."

    # Get all infrastructure
    INFRA=$(api_call "GET" "/infra")

    # Filter for demo infrastructure that might be orphaned
    DEMO_INFRA=$(echo "$INFRA" | jq -r '.[] | select(.name | startswith("demo-")) | .id')

    if [ -z "$DEMO_INFRA" ]; then
        success "No demo infrastructure found"
        return
    fi

    # Check each demo infra to see if it's still used
    echo "$DEMO_INFRA" | while read -r infra_id; do
        if [ -n "$infra_id" ]; then
            INFRA_DETAILS=$(api_call "GET" "/infra/$infra_id")
            DEPLOYMENTS=$(echo "$INFRA_DETAILS" | jq -r '.deployments | length')

            if [ "$DEPLOYMENTS" -eq 0 ]; then
                INFRA_NAME=$(echo "$INFRA_DETAILS" | jq -r '.name')
                api_call "DELETE" "/infra/$infra_id" > /dev/null && success "Deleted orphaned infrastructure: $INFRA_NAME"
            else
                INFRA_NAME=$(echo "$INFRA_DETAILS" | jq -r '.name')
                warn "Keeping infrastructure '$INFRA_NAME' - still has $DEPLOYMENTS deployment(s)"
            fi
        fi
    done
}

# Verify cleanup
verify_cleanup() {
    log "Verifying cleanup..."

    APPS=$(api_call "GET" "/applications" | jq length)
    COMPONENTS=$(api_call "GET" "/components" | jq length)
    INFRA=$(api_call "GET" "/infra" | jq length)

    echo ""
    echo "Remaining entities:"
    echo "  • Applications: $APPS"
    echo "  • Components: $COMPONENTS"
    echo "  • Infrastructure: $INFRA"

    if [ "$APPS" -eq 0 ] && [ "$COMPONENTS" -eq 0 ] && [ "$INFRA" -eq 0 ]; then
        success "Complete cleanup verified!"
    else
        warn "Some entities remain. This is normal if you had pre-existing data."
    fi
}

# Main execution
main() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                   AppCloud Demo Cleanup                      ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    log "Starting demo data cleanup..."
    echo "API Base: $API_BASE"
    echo ""

    delete_applications
    echo ""
    cleanup_orphaned_components
    echo ""
    cleanup_orphaned_infra
    echo ""
    verify_cleanup
    echo ""

    success "Demo cleanup complete!"
    echo ""
    warn "Note: Only demo applications and their exclusive components/infra were deleted."
    echo "Shared infrastructure or components from other applications were preserved."
}

main "$@"