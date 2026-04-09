// polystore-website/src/components/GatewayStatusWidget.tsx

import React from 'react';
import { useLocalGateway } from '../hooks/useLocalGateway';
import { Wifi, WifiOff, Loader2, AlertCircle } from 'lucide-react'; // Icons

interface GatewayStatusWidgetProps {
  pollInterval?: number;
  className?: string;
}

export const GatewayStatusWidget: React.FC<GatewayStatusWidgetProps> = ({ pollInterval, className }) => {
  const { status, url, error, details } = useLocalGateway(pollInterval);

  let icon: React.ReactNode = <AlertCircle className="w-4 h-4" />;
  let colorClass = 'text-muted-foreground';
  let text = 'Unknown';
  let tooltip = `Unknown gateway status: ${status}`;
  const caps =
    details?.capabilities
      ? Object.entries(details.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(', ')
      : '';
  const deps =
    details?.deps
      ? Object.entries(details.deps)
          .map(([name, ok]) => `${name}:${ok ? 'ok' : 'fail'}`)
          .join(', ')
      : '';
  const p2p = details?.p2p_addrs?.length ? details.p2p_addrs.join(', ') : '';

  if (error === 'Gateway disabled') {
    icon = <AlertCircle className="w-4 h-4" />;
    colorClass = 'text-muted-foreground';
    text = 'Local Gateway Off';
    tooltip = 'Local gateway checks are disabled by configuration.';
  } else switch (status) {
    case 'connected':
      icon = <Wifi className="w-4 h-4" />;
      colorClass = 'text-success';
      text = 'Connected';
      tooltip = `Local Gateway connected at ${url}${
        details?.mode ? ` (mode=${details.mode})` : ''
      }${caps ? ` | caps: ${caps}` : ''}${deps ? ` | deps: ${deps}` : ''}${p2p ? ` | p2p: ${p2p}` : ''}`;
      break;
    case 'connecting':
      icon = <Loader2 className="w-4 h-4 animate-spin" />;
      colorClass = 'text-primary';
      text = 'Connecting...';
      tooltip = `Attempting to connect to local gateway at ${url}`;
      break;
    case 'disconnected':
      icon = <WifiOff className="w-4 h-4" />;
      colorClass = 'text-destructive';
      text = 'Disconnected';
      tooltip = `Local Gateway disconnected. ${error || 'Service unreachable.'}`;
      break;
    case 'error':
      icon = <AlertCircle className="w-4 h-4" />;
      colorClass = 'text-destructive';
      text = 'Error';
      tooltip = `Error connecting to local gateway: ${error}`;
      break;
  }

  return (
    <div 
      data-testid="gateway-status-widget"
      data-status={status}
      className={`flex items-center gap-1 text-sm ${colorClass} ${className ?? ''}`}
      title={tooltip}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
};
