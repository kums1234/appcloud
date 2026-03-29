#!/bin/bash
# dev.sh
# Development workflow script for AppCloud API
# Provides commands for quick iteration, testing, and container management

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Project paths
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$PROJECT_ROOT/api"
COMPOSE_FILE="-f docker-compose.yml -f docker-compose.dev.yml"

log() { echo -e "${GREEN}▶${NC}  $*" >&2; }
success() { echo -e "${GREEN}✓${NC}  $*" >&2; }
warn() { echo -e "${YELLOW}⚠${NC}  $*" >&2; }
error() { echo -e "${RED}✗${NC}  $*" >&2; }

usage() {
    cat << EOF
AppCloud Development Workflow Script

USAGE:
    $0 <command> [options]

COMMANDS:
    up              Start development environment
    down            Stop development environment
    restart         Restart API service
    logs            Show API logs
    shell           Open shell in API container
    test            Run unit tests
    test:watch      Run unit tests in watch mode
    test:coverage   Run tests with coverage
    lint            Run linting (if configured)
    clean           Clean up containers and volumes

EXAMPLES:
    $0 up           # Start dev environment
    $0 test         # Run unit tests
    $0 shell        # Open container shell
    $0 logs         # View API logs

ENVIRONMENT:
    Code changes are automatically reflected due to volume mounting.
    Unit tests run quickly without full container setup.
EOF
}

check_dependencies() {
    if ! command -v docker &> /dev/null; then
        error "Docker is required but not installed"
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null; then
        error "Docker Compose is required but not installed"
        exit 1
    fi
}

api_container_running() {
    docker-compose $COMPOSE_FILE ps api | grep -q "Up"
}

wait_for_services() {
    log "Waiting for services to be ready..."
    docker-compose $COMPOSE_FILE exec -T api sh -c 'while ! nc -z db 7687; do sleep 1; done' 2>/dev/null || true
    docker-compose $COMPOSE_FILE exec -T api sh -c 'while ! nc -z postgres 5432; do sleep 1; done' 2>/dev/null || true
    success "Services are ready"
}

cmd_up() {
    log "Starting development environment..."
    docker-compose $COMPOSE_FILE up -d
    wait_for_services
    success "Development environment started"
    echo ""
    echo "API available at: http://localhost:3000"
    echo "Run '$0 test' to run unit tests"
    echo "Run '$0 shell' to open container shell"
}

cmd_down() {
    log "Stopping development environment..."
    docker-compose $COMPOSE_FILE down
    success "Development environment stopped"
}

cmd_restart() {
    log "Restarting API service..."
    docker-compose $COMPOSE_FILE restart api
    success "API service restarted"
}

cmd_logs() {
    docker-compose $COMPOSE_FILE logs -f api
}

cmd_shell() {
    if ! api_container_running; then
        error "API container is not running. Run '$0 up' first."
        exit 1
    fi

    log "Opening shell in API container..."
    docker-compose $COMPOSE_FILE exec api sh
}

cmd_test() {
    if ! api_container_running; then
        error "API container is not running. Run '$0 up' first."
        exit 1
    fi

    log "Running unit tests..."
    docker-compose $COMPOSE_FILE exec api npm test
}

cmd_test_watch() {
    if ! api_container_running; then
        error "API container is not running. Run '$0 up' first."
        exit 1
    fi

    log "Running unit tests in watch mode..."
    echo "Press Ctrl+C to stop watching"
    docker-compose $COMPOSE_FILE exec api npm run test:watch
}

cmd_test_coverage() {
    if ! api_container_running; then
        error "API container is not running. Run '$0 up' first."
        exit 1
    fi

    log "Running tests with coverage..."
    docker-compose $COMPOSE_FILE exec api npm run test:coverage
}

cmd_clean() {
    log "Cleaning up development environment..."
    docker-compose $COMPOSE_FILE down -v --remove-orphans
    docker system prune -f
    success "Cleanup complete"
}

main() {
    check_dependencies

    case "${1:-}" in
        up) cmd_up ;;
        down) cmd_down ;;
        restart) cmd_restart ;;
        logs) cmd_logs ;;
        shell) cmd_shell ;;
        test) cmd_test ;;
        test:watch) cmd_test_watch ;;
        test:coverage) cmd_test_coverage ;;
        clean) cmd_clean ;;
        *) usage ;;
    esac
}

main "$@"