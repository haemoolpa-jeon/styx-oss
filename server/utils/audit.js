// Circular buffer audit logging system

/** @constant {number} Maximum audit log entries before overwrite */
const MAX_AUDIT_LOGS = 1000;
const auditLog = new Array(MAX_AUDIT_LOGS);
let auditLogHead = 0;
let auditLogCount = 0;

/**
 * Log a security event to the audit log
 * @param {string} event - Event type (e.g., 'LOGIN_SUCCESS', 'IP_BLOCKED')
 * @param {Object} details - Event details (ip, username, etc.)
 */
function logSecurityEvent(event, details) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    ...details
  };
  
  auditLog[auditLogHead] = logEntry;
  auditLogHead = (auditLogHead + 1) % MAX_AUDIT_LOGS;
  if (auditLogCount < MAX_AUDIT_LOGS) auditLogCount++;
  
  console.log(`[AUDIT] ${event}:`, JSON.stringify(details));
}

/**
 * Get audit logs with pagination (newest first)
 * @param {number} [limit=100] - Max entries to return
 * @param {number} [offset=0] - Entries to skip
 * @returns {Object[]} Array of log entries
 */
function getAuditLogs(limit = 100, offset = 0) {
  const logs = [];
  const start = (auditLogHead - auditLogCount + MAX_AUDIT_LOGS) % MAX_AUDIT_LOGS;
  for (let i = 0; i < auditLogCount; i++) {
    logs.push(auditLog[(start + i) % MAX_AUDIT_LOGS]);
  }
  return logs.reverse().slice(offset, offset + limit);
}

function getAuditLogCount() {
  return auditLogCount;
}

module.exports = { logSecurityEvent, getAuditLogs, getAuditLogCount, MAX_AUDIT_LOGS };
