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
  const configPath = process.env.RISCO_MQTT_HA_CONFIG_FILE || path.join(process.cwd(), 'config.json');
  const defaultConfigPath = process.env.RISCO_MQTT_HA_DEFAULT_CONFIG || path.join(__dirname, '../config.default.json');

  if (!fs.existsSync(configPath) && fs.existsSync(defaultConfigPath)) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(defaultConfigPath, configPath);
    console.log(`Config not found. Copied defaults to ${configPath}`);
  }

  console.log('Loading config from: ' + configPath);
  if (fs.existsSync(configPath)) {
    const config = require(configPath);
    const allowedLogs = ['error', 'warn', 'info', 'verbose', 'debug'];
    if (config.log && !allowedLogs.includes(config.log)) {
      console.warn(`Invalid log level "${config.log}", falling back to "info"`);
      config.log = 'info';
    }
    console.debug('Config (masked): ' + JSON.stringify(maskConfig(config), null, 2));
    riscoMqttHomeAssistant(config);
  } else {
    console.error(`file ${configPath} does not exist`);
    process.exit(1);
  }
} catch (e) {
  console.error('Startup error', e);
  process.exit(1);
}
