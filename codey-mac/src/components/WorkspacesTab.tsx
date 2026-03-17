import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Workspace } from '../types';
import { apiService } from '../services/api';

interface WorkspacesTabProps {
  isGatewayRunning: boolean;
}

export const WorkspacesTab: React.FC<WorkspacesTabProps> = ({ isGatewayRunning }) => {
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isGatewayRunning) {
      loadWorkspaces();
    }
  }, [isGatewayRunning]);

  const loadWorkspaces = async () => {
    try {
      const ws = await apiService.getWorkspaces();
      setWorkspaces(ws);
    } catch (error) {
      console.error('Failed to load workspaces:', error);
    }
  };

  const switchWorkspace = async (name: string) => {
    setLoading(true);
    try {
      await apiService.switchWorkspace(name);
      setCurrentWorkspace(name);
    } catch (error) {
      console.error('Failed to switch workspace:', error);
    } finally {
      setLoading(false);
    }
  };

  if (!isGatewayRunning) {
    return (
      <View style={styles.container}>
        <Text style={styles.offline}>Start the gateway to manage workspaces</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.section}>Workspaces</Text>
      {workspaces.length === 0 ? (
        <Text style={styles.empty}>No workspaces found</Text>
      ) : (
        <ScrollView>
          {workspaces.map(ws => (
            <TouchableOpacity
              key={ws}
              style={[styles.workspaceItem, currentWorkspace === ws && styles.activeWorkspace]}
              onPress={() => switchWorkspace(ws)}
              disabled={loading}
            >
              <Text style={styles.workspaceName}>{ws}</Text>
              {currentWorkspace === ws && <Text style={styles.activeBadge}>Active</Text>}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  offline: { color: '#888', textAlign: 'center', marginTop: 40 },
  section: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16 },
  empty: { color: '#888' },
  workspaceItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#2a2a2a', borderRadius: 8, marginBottom: 8 },
  activeWorkspace: { borderColor: '#007AFF', borderWidth: 1 },
  workspaceName: { color: '#fff', fontSize: 14 },
  activeBadge: { color: '#007AFF', fontSize: 12 },
});
