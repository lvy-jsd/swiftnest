import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome } from './profile.js';

export interface EmployeeProfile {
  id: string;
  name: string;
  role: 'code' | 'ui' | 'qa' | 'manager';
  avatar: string;
  currentSessionId?: string;
  memoryRef: string;
  lastActivity: number;
  models: {
    primary: string;
    task: string;
  };
  envConfig: {
    networkAccess: string[];
    secrets: string[];
  };
}

export class EmployeeStore {
  private path: string;
  constructor(home: string = dshHome) {
    this.path = join(home, 'employees.json');
  }

  load(): EmployeeProfile[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return [];
    }
  }

  save(employees: EmployeeProfile[]): void {
    writeFileSync(this.path, JSON.stringify(employees, null, 2));
  }
}
