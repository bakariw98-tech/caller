import { getDb, applySchema } from './index.js';
import { config } from '../config.js';

applySchema(getDb());
console.log(`schema applied to ${config.databasePath}`);
