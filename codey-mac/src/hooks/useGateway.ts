import { useState, useCallback, useEffect } from 'react';
import { ipcService } from '../services/ipc';
import { apiService } from '../services/api';
import { GatewayStatus } from '../types';

export const useGateway = (gatewayPath: string) => {
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<GatewayStatus>({
    status: 'stopped',
    uptime: 0,
    messagesProcessed: 0,
    errors: 0,
    channels: { telegram: false, discord: false, imessage: false },
  });
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((line: string, isError: boolean) => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = isError ? '❌' : '📝';
    setLogs(prev => [...prev.slice(-100), `${timestamp} ${prefix} ${line}`]);
  }, []);

  const start = useCallback(async () => {
    try {
      await ipcService.start(gatewayPath, addLog);
      setIsRunning(true);
      addLog('Gateway started', false);
    } catch (error) {
      addLog(`Failed to start: ${error}`, true);
    }
  }, [gatewayPath, addLog]);

  const stop = useCallback(async () => {
    try {
      await ipcService.stop();
      setIsRunning(false);
      addLog('Gateway stopped', false);
    } catch (error) {
      addLog(`Failed to stop: ${error}`, true);
    }
  }, [addLog]);

  const toggle = useCallback(() => {
    if (isRunning) {
      stop();
    } else {
      start();
    }
  }, [isRunning, start, stop]);

  // Poll for status when running
  useEffect(() => {
    if (!isRunning) return;

    const pollStatus = async () => {
      const newStatus = await apiService.getStatus();
      setStatus(newStatus);
    };

    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [isRunning]);

  return {
    isRunning,
    status,
    logs,
    start,
    stop,
    toggle,
  };
};
