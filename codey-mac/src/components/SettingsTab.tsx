import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Switch, StyleSheet } from 'react-native';
import { GatewayConfig } from '../types';
import { apiService } from '../services/api';

interface SettingsTabProps {
  isGatewayRunning: boolean;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({ isGatewayRunning }) => {
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [editedConfig, setEditedConfig] = useState<GatewayConfig | null>(null);
  const [port, setPort] = useState('3000');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isGatewayRunning) {
      loadConfig();
    }
  }, [isGatewayRunning]);

  const loadConfig = async () => {
    try {
      const cfg = await apiService.getConfig();
      setConfig(cfg);
      setEditedConfig(cfg);
      setPort(cfg.gateway.port.toString());
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  };

  const saveConfig = async () => {
    if (!editedConfig) return;
    setSaving(true);
    try {
      await apiService.setConfig(editedConfig);
      setConfig(editedConfig);
    } catch (error) {
      console.error('Failed to save config:', error);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (path: string, value: any) => {
    if (!editedConfig) return;
    const parts = path.split('.');
    // @ts-ignore
    let obj = editedConfig;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    setEditedConfig({ ...editedConfig });
  };

  if (!isGatewayRunning) {
    return (
      <View style={styles.container}>
        <Text style={styles.offline}>Start the gateway to edit settings</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.section}>Gateway</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Port</Text>
        <TextInput
          style={styles.input}
          value={port}
          onChangeText={setPort}
          keyboardType="numeric"
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Default Agent</Text>
        <TextInput
          style={styles.input}
          value={editedConfig?.gateway.defaultAgent || ''}
          onChangeText={(v) => updateField('gateway.defaultAgent', v)}
        />
      </View>

      <Text style={styles.section}>Channels</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Telegram</Text>
        <Switch
          value={editedConfig?.channels.telegram?.enabled || false}
          onValueChange={(v) => updateField('channels.telegram.enabled', v)}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Discord</Text>
        <Switch
          value={editedConfig?.channels.discord?.enabled || false}
          onValueChange={(v) => updateField('channels.discord.enabled', v)}
        />
      </View>

      <Text style={styles.section}>API Keys</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Anthropic</Text>
        <TextInput
          style={styles.input}
          value={editedConfig?.apiKeys.anthropic || ''}
          onChangeText={(v) => updateField('apiKeys.anthropic', v)}
          secureTextEntry
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>OpenAI</Text>
        <TextInput
          style={styles.input}
          value={editedConfig?.apiKeys.openai || ''}
          onChangeText={(v) => updateField('apiKeys.openai', v)}
          secureTextEntry
        />
      </View>

      <TouchableOpacity style={styles.saveButton} onPress={saveConfig} disabled={saving}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving...' : 'Save'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  offline: { color: '#888', textAlign: 'center', marginTop: 40 },
  section: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 20, marginBottom: 12 },
  field: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  label: { color: '#ccc' },
  input: { backgroundColor: '#2a2a2a', color: '#fff', padding: 8, borderRadius: 4, width: 200 },
  saveButton: { backgroundColor: '#007AFF', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 20 },
  saveButtonText: { color: '#fff', fontWeight: '600' },
});
