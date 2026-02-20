package main

import (
	"fmt"
	"net"
	"os"
	"strings"
)

type runtimePersona string

const (
	runtimePersonaUserGateway    runtimePersona = "user-gateway"
	runtimePersonaProviderDaemon runtimePersona = "provider-daemon"
)

func (p runtimePersona) String() string {
	if p == "" {
		return string(runtimePersonaUserGateway)
	}
	return string(p)
}

func hasProviderIdentityConfigured() bool {
	return strings.TrimSpace(os.Getenv("NIL_PROVIDER_KEY")) != "" || strings.TrimSpace(os.Getenv("NIL_PROVIDER_ADDRESS")) != ""
}

func resolveRuntimePersona(routerMode bool) runtimePersona {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("NIL_RUNTIME_PERSONA")))
	switch raw {
	case "user-gateway", "user_gateway", "gateway", "router":
		return runtimePersonaUserGateway
	case "provider-daemon", "provider_daemon", "provider", "sp":
		return runtimePersonaProviderDaemon
	}

	// Compatibility inference for environments that haven't set NIL_RUNTIME_PERSONA yet.
	if routerMode {
		return runtimePersonaUserGateway
	}
	if hasProviderIdentityConfigured() {
		return runtimePersonaProviderDaemon
	}
	return runtimePersonaUserGateway
}

func listenPortFromAddr(addr string) string {
	raw := strings.TrimSpace(addr)
	if raw == "" {
		return ""
	}
	// Common short form ":8080"
	if strings.HasPrefix(raw, ":") {
		return strings.TrimPrefix(raw, ":")
	}
	if host, port, err := net.SplitHostPort(raw); err == nil {
		_ = host
		return strings.TrimSpace(port)
	}
	return ""
}

func validateRuntimePersona(persona runtimePersona, routerMode bool, listenAddr string) error {
	switch persona {
	case runtimePersonaUserGateway:
		if hasProviderIdentityConfigured() {
			return fmt.Errorf("user-gateway persona does not allow provider identity env; unset NIL_PROVIDER_KEY/NIL_PROVIDER_ADDRESS")
		}
		return nil
	case runtimePersonaProviderDaemon:
		if routerMode {
			return fmt.Errorf("provider-daemon persona cannot run in router mode (NIL_GATEWAY_ROUTER=1)")
		}
		if !hasProviderIdentityConfigured() {
			return fmt.Errorf("provider-daemon persona requires NIL_PROVIDER_KEY or NIL_PROVIDER_ADDRESS")
		}
		if listenPortFromAddr(listenAddr) == "8080" && envDefault("NIL_ALLOW_PROVIDER_ON_USER_PORT", "0") != "1" {
			return fmt.Errorf("provider-daemon persona cannot listen on :8080 (reserved for trusted user-gateway). set NIL_LISTEN_ADDR to a provider port (e.g. :8082) or set NIL_ALLOW_PROVIDER_ON_USER_PORT=1 only for legacy compatibility")
		}
		return nil
	default:
		return fmt.Errorf("unknown runtime persona %q", persona)
	}
}

func allowedRouteFamiliesForPersona(persona runtimePersona) []string {
	switch persona {
	case runtimePersonaProviderDaemon:
		return []string{"sp", "sp/retrieval"}
	default:
		return []string{"gateway"}
	}
}

func currentRuntimePersona() runtimePersona {
	return resolveRuntimePersona(isGatewayRouterMode())
}
