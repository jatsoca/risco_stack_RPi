#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
import { riscoMqttHomeAssistant } from './lib';

function maskConfig(raw: any) {
  const clone = JSON.parse(JSON.stringify(raw));
  if (clone?.panel?.panelPassword !== undefined) clone.panel.panelPassword = '***';
  if (clone?.panel?.panelPassword2 !== undefined) clone.panel.panelPassword2 = '***';
  return clone;
}

try {
  const candidates = [
    process.env.RISCO_MQTT_HA_CONFIG_FILE,
    path.resolve(__dirname, '../config.json'),
    path.resolve(__dirname, '../../config.json'),
    path.resolve(process.cwd(), 'config.json'),
  ].filter(Boolean) as string[];

  let configPath = '';
  for (const p of candidates) {
    if (fs.existsSync(p)) { configPath = p; break; }
  }

  // Si no hay config, creamos una en ../data/config.json copiando defaults
  if (!configPath) {
    const dataPath = path.resolve(__dirname, '../data/config.json');
    const defaultConfigPath = process.env.RISCO_MQTT_HA_DEFAULT_CONFIG || path.resolve(__dirname, '../config.default.json');
    const fallbackDefault = fs.existsSync(defaultConfigPath) ? defaultConfigPath : path.resolve(__dirname, '../../config.default.json');
    if (!fs.existsSync(fallbackDefault)) {
      console.error('No config found and no default config available');
      process.exit(1);
    }
    await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
    fs.copyFileSync(fallbackDefault, dataPath);
    configPath = dataPath;
    console.log(`Config not found. Copied defaults to ${configPath}`);
  }

  console.log('Loading config from: ' + configPath);
  const config = require(configPath);
  const allowedLogs = ['error', 'warn', 'info', 'verbose', 'debug'];
  if (config.log && !allowedLogs.includes(config.log)) {
    console.warn(`Invalid log level "${config.log}", falling back to "info"`);
    config.log = 'info';
  }
  console.debug('Config (masked): ' + JSON.stringify(maskConfig(config), null, 2));
  riscoMqttHomeAssistant(config);
} catch (e) {
  console.error('Startup error', e);
  process.exit(1);
}
