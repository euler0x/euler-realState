import { CustomThemes } from '~/types';

export type Env = Record<string, never>;

export interface Constants {
  RPC_URL_TESTING: string;
}

export interface Config {
  env: Env;
  constants: Constants;
  customThemes: CustomThemes;
}
