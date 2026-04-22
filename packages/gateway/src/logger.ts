import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private logLevel: LogLevel;
  private logFile?: string;
  private errorLogFile?: string;
  private static instance: Logger;

  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(logLevel: LogLevel = 'info', logFile?: string) {
    this.logLevel = logLevel;
    this.logFile = logFile;
  }

  static getInstance(logLevel?: LogLevel, logFile?: string): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(logLevel, logFile);
    }
    return Logger.instance;
  }

  setLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  setLogFile(logFile: string): void {
    this.logFile = logFile;
  }

  setErrorLogFile(errorLogFile: string): void {
    this.errorLogFile = errorLogFile;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelPriority[level] >= this.levelPriority[this.logLevel];
  }

  private format(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    const color = this.getColor(level);
    const reset = '\x1b[0m';
    return `${color}[${timestamp}] [${level.toUpperCase()}]${reset} ${message}`;
  }

  private getColor(level: LogLevel): string {
    const colors: Record<LogLevel, string> = {
      debug: '\x1b[36m',    // Cyan
      info: '\x1b[32m',     // Green
      warn: '\x1b[33m',     // Yellow
      error: '\x1b[31m',    // Red
    };
    return colors[level];
  }

  private write(level: LogLevel, message: string): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.format(level, message);
    console.log(formatted);

    const fileMsg = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;

    // Write to app log
    if (this.logFile) {
      fs.appendFileSync(this.logFile, fileMsg);
    }

    // Write errors and warnings to error log
    if (this.errorLogFile && (level === 'error' || level === 'warn')) {
      fs.appendFileSync(this.errorLogFile, fileMsg);
    }
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  // Table for displaying data
  table(headers: string[], rows: string[][]): void {
    const colWidths = headers.map((h, i) => 
      Math.max(h.length, ...rows.map(r => (r[i] || '').length))
    );

    const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join(' │ ');
    const separator = colWidths.map(w => '─'.repeat(w)).join(' ─┼─ ');

    console.log('\n' + '\x1b[1m' + headerRow + '\x1b[0m');
    console.log(separator);
    rows.forEach(row => {
      const formatted = row.map((cell, i) => (cell || '').padEnd(colWidths[i])).join(' │ ');
      console.log(formatted);
    });
    console.log('');
  }

  // Box for status display
  box(title: string, content: string): void {
    const lines = content.split('\n');
    const width = Math.max(title.length, ...lines.map(l => l.length)) + 4;
    
    console.log('\n┌' + '─'.repeat(width) + '┐');
    console.log('│ ' + title.padEnd(width - 1) + '│');
    console.log('├' + '─'.repeat(width) + '┤');
    lines.forEach(line => {
      console.log('│ ' + line.padEnd(width - 1) + '│');
    });
    console.log('└' + '─'.repeat(width) + '┘\n');
  }

  // Progress bar
  progress(current: number, total: number, label: string = ''): void {
    const barLength = 30;
    const percent = current / total;
    const filled = Math.round(barLength * percent);
    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
    const pct = Math.round(percent * 100);
    
    process.stdout.write(`\r${label} [${bar}] ${pct}%`);
    if (current === total) {
      process.stdout.write('\n');
    }
  }

  // Clear screen
  clear(): void {
    console.clear();
  }

  // Banner
  banner(text: string): void {
    const width = text.length + 4;
    console.log('\n' + '═'.repeat(width));
    console.log('║ ' + text + ' ║');
    console.log('═'.repeat(width) + '\n');
  }
}
