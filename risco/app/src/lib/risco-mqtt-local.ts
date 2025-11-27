import merge from 'lodash/merge';
import {
  RiscoPanel,
  RiscoLogger,
  Partition,
  PartitionList,
  Zone,
  ZoneList,
  PanelOptions,
} from '@vanackej/risco-lan-bridge/dist';
import pkg from 'winston';
import { startWebServer, RealtimeState } from '../web/server';

const { createLogger, format, transports } = pkg;
const { combine, timestamp, printf, colorize } = format;

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

export interface RiscoConfig {
  log?: LogLevel,
  logColorize?: boolean,
  panel_name?: string,
  panel_node_id?: string,
  web?: {
    enable?: boolean,
    http_port?: number,
    ws_path?: string,
  },
  modbus?: {
    enable?: boolean,
    port?: number,
    host?: string,
  },
  zones?: {
    default?: ZoneConfig
    [label: string]: ZoneConfig
  }
  panel: PanelOptions
}

export interface ZoneConfig {
  off_delay?: number,
  device_class?: string,
  name?: string
  name_prefix?: string
}

const CONFIG_DEFAULTS: RiscoConfig = {
  log: 'info',
  logColorize: false,
  panel_name: 'Risco Alarm',
  panel_node_id: null,
  web: {
    enable: false,
    http_port: 8080,
    ws_path: '/ws',
  },
  modbus: {
    enable: true,
    port: 502,
    host: '0.0.0.0',
  },
  panel: {},
  zones: {
    default: {
      off_delay: 0,
      device_class: 'motion',
      name_prefix: '',
    },
  },
};

export function riscoMqttHomeAssistant(userConfig: RiscoConfig) {

  const config = merge(CONFIG_DEFAULTS, userConfig);

  let logFmt = combine(
    timestamp({
      format: () => new Date().toLocaleString(),
    }),
    printf(({ level, message, timestamp }) => {
      return `${timestamp} [${level}] ${message}`;
    }),
  );
  if (config.logColorize) {
    logFmt = combine(
      colorize({
        all: false,
        level: true,
      }),
      logFmt,
    );
  }
  config.panel_name = config.panel_name.trim();
  if (!config.panel_node_id) {
    config.panel_node_id = config.panel_name.replace(/\s+/g, "_").toLowerCase();
  }

  const logger = createLogger({
    format: logFmt,
    level: config.log || 'info',
    transports: [
      new transports.Console(),
    ],
  });

  logger.debug(`User config:\n${JSON.stringify(userConfig, null, 2)}`);
  logger.debug(`Merged config:\n${JSON.stringify({ ...config, panel: { ...config.panel, panelPassword: '***' } }, null, 2)}`);

  class WinstonRiscoLogger implements RiscoLogger {
    log(log_lvl: LogLevel, log_data: any) {
      logger.log(log_lvl, log_data);
    }
  }

  config.panel.logger = new WinstonRiscoLogger();

  let panelReady = false;
  let listenerInstalled = false;

  const panel = new RiscoPanel(config.panel);

  const rtState: RealtimeState = { partitions: new Map(), zones: new Map(), panel: { online: false } };
  let webHooks: ReturnType<typeof startWebServer> | null = null;

  // Arranca Web/Modbus aunque el panel no esté conectado
  function ensureWebStarted() {
    if (webHooks || !(config.web?.enable ?? false)) return;
    webHooks = startWebServer(
      {
        http_port: config.web?.http_port || 8080,
        ws_path: config.web?.ws_path || '/ws',
      },
      {
        enable: config.modbus?.enable ?? true,
        port: config.modbus?.port ?? 502,
        host: config.modbus?.host || '0.0.0.0',
      },
      rtState,
      async (partitionId, mode) => {
        if (!panelReady) return false;
        logger.info(`[CMD => Panel][web/modbus] partition ${partitionId} mode=${mode}`);
        let ok = false;
        if (mode === 'disarm') ok = await panel.disarmPart(partitionId);
        else if (mode === 'home') ok = await panel.armHome(partitionId);
        else if (mode === 'away') ok = await panel.armAway(partitionId);
        logger.info(`[CMD => Panel][web/modbus] partition ${partitionId} result=${ok}`);
        return ok;
      },
      async (zoneId) => {
        if (!panelReady) return false;
        try {
          logger.info(`[CMD => Panel][web/modbus] toggle bypass zone ${zoneId}`);
          await panel.toggleBypassZone(zoneId);
          return true;
        } catch (e) {
          logger.error(`[WEB => Panel] Error toggling bypass zone ${zoneId}: ${e}`);
          return false;
        }
      }
    );
    webHooks.updatePanelStatus(false);
  }
  ensureWebStarted();

  (panel as any).on?.('SystemInitComplete', () => {
    (panel.riscoComm.tcpSocket as any).on?.('Disconnected', () => {
      panelReady = false;
      webHooks?.updatePanelStatus(false);
    });
    if (!panelReady) {
      panelReady = true;
      webHooks?.updatePanelStatus(true);
      onPanelReady();
    }
  });

  function alarmPayload(partition: Partition) {
    if (partition.Alarm) {
      return 'triggered';
    } else if (!partition.Arm && !partition.HomeStay) {
      return 'disarmed';
    } else {
      if (partition.HomeStay) {
        return 'armed_home';
      } else {
        return 'armed_away';
      }
    }
  }

  function getPartitionReady(partition: Partition): boolean {
    return !!partition.Ready;
  }

  function publishPartitionReadyStateChange(partition: Partition) {
    const ready = getPartitionReady(partition);
    rtState.partitions.set(partition.Id, { id: partition.Id, status: alarmPayload(partition), ready });
    webHooks?.updatePartition({ id: partition.Id, status: alarmPayload(partition), ready });
    logger.info(`[Panel => STATE] Ready=${ready} partition ${partition.Id}`);
  }

  function publishPartitionStateChanged(partition: Partition) {
    const payload = alarmPayload(partition);
    const ready = getPartitionReady(partition);
    rtState.partitions.set(partition.Id, { id: partition.Id, status: payload, ready });
    webHooks?.updatePartition({ id: partition.Id, status: payload, ready });
    logger.info(`[Panel => STATE] Partition ${partition.Id} status=${payload}`);
    publishPartitionReadyStateChange(partition);
  }

  function publishZoneStateChange(zone: Zone, publishAttributes: boolean) {
    // publishAttributes se mantiene por compatibilidad, pero sólo afectamos estado
    const zoneStatus = zone.Open ? '1' : '0';
    rtState.zones.set(zone.Id, { id: zone.Id, open: zone.Open, bypass: zone.Bypass, label: zone.Label });
    webHooks?.updateZone({ id: zone.Id, open: zone.Open, bypass: zone.Bypass, label: zone.Label });
    logger.info(`[Panel => STATE] Zone ${zone.Label} (${zone.Id}) open=${zone.Open}`);
  }

  function publishZoneBypassStateChange(zone: Zone) {
    rtState.zones.set(zone.Id, { id: zone.Id, open: zone.Open, bypass: zone.Bypass, label: zone.Label });
    webHooks?.updateZone({ id: zone.Id, open: zone.Open, bypass: zone.Bypass, label: zone.Label });
    logger.info(`[Panel => STATE] Zone ${zone.Label} (${zone.Id}) bypass=${zone.Bypass}`);
  }

  function activePartitions(partitions: PartitionList): Partition[] {
    return partitions.values.filter(p => p.Exist);
  }

  function activeZones(zones: ZoneList): Zone[] {
    return zones.values.filter(z => !z.NotUsed);
  }

  function onPanelReady() {
    logger.info(`Panel communications are ready`);
    ensureWebStarted();

    // initial state to web/modbus
    for (const partition of activePartitions(panel.partitions)) {
      publishPartitionStateChanged(partition);
    }
    for (const zone of activeZones(panel.zones)) {
      publishZoneStateChange(zone, true);
      publishZoneBypassStateChange(zone);
    }

    if (!listenerInstalled) {
      logger.info(`Subscribing to panel partitions events`);
      (panel.partitions as any).on?.('PStatusChanged', (Id, EventStr) => {
        const p = panel.partitions.byId(Id);
        const safePartition = p ? { Id: p.Id, Status: p.Status, Ready: p.Ready } : { Id };
        logger.debug(`[Panel Event] Partition ${Id} => ${EventStr} state=${JSON.stringify(safePartition)}`);
        if (['Armed', 'Disarmed', 'HomeStay', 'HomeDisarmed', 'Alarm', 'StandBy'].includes(EventStr)) {
          publishPartitionStateChanged(panel.partitions.byId(Id));
        }
        if (['Ready', 'NotReady', 'StandBy'].includes(EventStr) || EventStr.toLowerCase().includes('ready')) {
          publishPartitionReadyStateChange(panel.partitions.byId(Id));
        }
      });

      logger.info(`Subscribing to panel zones events`);
      (panel.zones as any).on?.('ZStatusChanged', (Id, EventStr) => {
        const z = panel.zones.byId(Id);
        const safeZone = z ? { Id: z.Id, Status: z.Status, Open: z.Open, Bypassed: (z as any).Bypassed ?? z.Bypass } : { Id };
        logger.debug(`[Panel Event] Zone ${Id} => ${EventStr} state=${JSON.stringify(safeZone)}`);
        if (['Closed', 'Open'].includes(EventStr)) {
          publishZoneStateChange(panel.zones.byId(Id), false);
        }
        if (['Bypassed', 'UnBypassed'].includes(EventStr)) {
          publishZoneBypassStateChange(panel.zones.byId(Id));
        }
      });

      listenerInstalled = true;
    } else {
      logger.info('Listeners already installed, skipping listeners registration');
    }

    logger.info(`Initialization completed`);
    webHooks?.updatePanelStatus(true);
  }

}
