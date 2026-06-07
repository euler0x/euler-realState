import { getMuiThemeConfig } from './muiThemeConfig';
import { customTheme } from './theme';

export const getCustomThemes = () => {
  return {
    getMui: getMuiThemeConfig(customTheme),
  };
};
