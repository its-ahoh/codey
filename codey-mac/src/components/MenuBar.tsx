import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface MenuBarProps {
  isRunning: boolean;
  onToggle: () => void;
  onOpenWindow: () => void;
  onQuit: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  isRunning,
  onToggle,
  onOpenWindow,
  onQuit,
}) => {
  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={onOpenWindow} style={styles.iconContainer}>
        <View style={[styles.statusDot, isRunning ? styles.running : styles.stopped]} />
        <Text style={styles.iconText}>Codey</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onToggle} style={styles.menuItem}>
        <Text>{isRunning ? 'Stop Gateway' : 'Start Gateway'}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onOpenWindow} style={styles.menuItem}>
        <Text>Open Window</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onQuit} style={styles.menuItem}>
        <Text>Quit</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#2d2d2d',
    borderRadius: 8,
    padding: 8,
    minWidth: 150,
  },
  iconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    marginBottom: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  running: {
    backgroundColor: '#4CAF50',
  },
  stopped: {
    backgroundColor: '#9E9E9E',
  },
  iconText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  menuItem: {
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#444',
  },
});
