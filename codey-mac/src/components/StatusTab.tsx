import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { GatewayStatus } from '../types';

interface StatusTabProps {
  status: GatewayStatus;
  logs: string[];
  isRunning: boolean;
  onToggle: () => void;
}

const formatUptime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
};

export const StatusTab: React.FC<StatusTabProps> = ({ status, logs, isRunning, onToggle }) => {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Gateway Status</Text>
        <TouchableOpacity
          style={[styles.toggleButton, isRunning ? styles.stopButton : styles.startButton]}
          onPress={onToggle}
        >
          <Text style={styles.toggleText}>{isRunning ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statsGrid}>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Status</Text>
          <Text style={[styles.statValue, isRunning ? styles.running : styles.stopped]}>
            {isRunning ? 'Running' : 'Stopped'}
          </Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Uptime</Text>
          <Text style={styles.statValue}>{isRunning ? formatUptime(status.uptime) : '-'}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Messages</Text>
          <Text style={styles.statValue}>{status.messagesProcessed}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Errors</Text>
          <Text style={styles.statValue}>{status.errors}</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Channels</Text>
      <View style={styles.channels}>
        <Text style={styles.channel}>Telegram: {status.channels.telegram ? '✓' : '✗'}</Text>
        <Text style={styles.channel}>Discord: {status.channels.discord ? '✓' : '✗'}</Text>
        <Text style={styles.channel}>iMessage: {status.channels.imessage ? '✓' : '✗'}</Text>
      </View>

      <Text style={styles.sectionTitle}>Logs</Text>
      <ScrollView style={styles.logs}>
        {logs.map((log, index) => (
          <Text key={index} style={styles.logLine}>{log}</Text>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 20, fontWeight: '600', color: '#fff' },
  toggleButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  startButton: { backgroundColor: '#4CAF50' },
  stopButton: { backgroundColor: '#f44336' },
  toggleText: { color: '#fff', fontWeight: '600' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20 },
  statItem: { width: '50%', paddingVertical: 8 },
  statLabel: { color: '#888', fontSize: 12 },
  statValue: { color: '#fff', fontSize: 18, fontWeight: '600' },
  running: { color: '#4CAF50' },
  stopped: { color: '#9E9E9E' },
  sectionTitle: { color: '#888', fontSize: 14, marginBottom: 8, marginTop: 12 },
  channels: { flexDirection: 'row', gap: 16 },
  channel: { color: '#ccc' },
  logs: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 8, padding: 12 },
  logLine: { color: '#888', fontSize: 11, fontFamily: 'monospace' },
});
