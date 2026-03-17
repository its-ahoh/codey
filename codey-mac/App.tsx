import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Modal } from 'react-native';
import { useGateway } from './src/hooks/useGateway';
import { ChatTab } from './src/components/ChatTab';
import { StatusTab } from './src/components/StatusTab';
import { SettingsTab } from './src/components/SettingsTab';
import { WorkspacesTab } from './src/components/WorkspacesTab';

type TabType = 'chat' | 'status' | 'settings' | 'workspaces';

const GATEWAY_PATH = '/Users/jackou/Documents/projects/codey';

const App = () => {
  const [activeTab, setActiveTab] = useState<TabType>('chat');
  const [showWindow, setShowWindow] = useState(false);
  const { isRunning, status, logs, toggle } = useGateway(GATEWAY_PATH);

  const tabs: { key: TabType; label: string }[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'status', label: 'Status' },
    { key: 'settings', label: 'Settings' },
    { key: 'workspaces', label: 'Workspaces' },
  ];

  const renderTab = () => {
    switch (activeTab) {
      case 'chat':
        return <ChatTab isGatewayRunning={isRunning} />;
      case 'status':
        return <StatusTab status={status} logs={logs} isRunning={isRunning} onToggle={toggle} />;
      case 'settings':
        return <SettingsTab isGatewayRunning={isRunning} />;
      case 'workspaces':
        return <WorkspacesTab isGatewayRunning={isRunning} />;
    }
  };

  if (!showWindow) {
    return (
      <View style={styles.menuBar}>
        <TouchableOpacity style={styles.menuItem} onPress={() => setShowWindow(true)}>
          <View style={[styles.statusDot, isRunning ? styles.running : styles.stopped]} />
          <Text style={styles.menuText}>Codey</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={toggle}>
          <Text style={styles.menuText}>{isRunning ? 'Stop' : 'Start'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={() => setShowWindow(true)}>
          <Text style={styles.menuText}>Open</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.menuItem} onPress={() => {}}>
          <Text style={styles.menuText}>Quit</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.tabBar}>
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.activeTab]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.activeTabText]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.content}>{renderTab()}</View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a1a' },
  menuBar: { backgroundColor: '#2d2d2d', padding: 8, borderRadius: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', padding: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  running: { backgroundColor: '#4CAF50' },
  stopped: { backgroundColor: '#9E9E9E' },
  menuText: { color: '#fff' },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#333' },
  tab: { flex: 1, padding: 14, alignItems: 'center' },
  activeTab: { borderBottomWidth: 2, borderBottomColor: '#007AFF' },
  tabText: { color: '#888' },
  activeTabText: { color: '#fff', fontWeight: '600' },
  content: { flex: 1 },
});

export default App;
