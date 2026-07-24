declare module "lunar-javascript" {
  export interface LunarDate {
    getMonthInChinese(): string;
    getDayInChinese(): string;
    getYearInGanZhi(): string;
    getMonthInGanZhi(): string;
    getDayInGanZhi(): string;
    getYearShengXiao(): string;
    getDayYi(sect?: number): string[];
    getDayJi(sect?: number): string[];
    getJieQi(): string;
    getFestivals(): string[];
    getOtherFestivals(): string[];
    getDayChongDesc(): string;
    getDaySha(): string;
    getPengZuGan(): string;
    getPengZuZhi(): string;
    getZhiXing(): string;
    getDayTianShen(): string;
    getDayTianShenType(): string;
    getDayTianShenLuck(): string;
  }

  export interface SolarDate {
    getLunar(): LunarDate;
  }

  export const Solar: {
    fromYmd(year: number, month: number, day: number): SolarDate;
  };
}
