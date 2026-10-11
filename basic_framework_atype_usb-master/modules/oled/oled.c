#include "oled.h"
#include "oledfont.h"
#include "main.h"
#include <stdio.h>
#include <stdarg.h>
#include "bsp_dwt.h"
#include "adc.h"
static uint8_t OLED_GRAM[128][8];
/**
 * @brief   write data/command to OLED
 * @param   dat: the data ready to write
 * @param   cmd: 0x00,command 0x01,data
 * @retval
 */
void oled_write_byte(uint8_t dat, uint8_t cmd)
{
    if (cmd != 0)
        OLED_CMD_Set();
    else
        OLED_CMD_Clr();

    HAL_SPI_Transmit(&hspi1, &dat, 1, 10);
}
/**
 * @brief   clear the screen
 * @param   None
 * @param   None
 * @retval
 */
void OLED_clear(Pen_Typedef pen)
{
    uint8_t i, n;

    for (i = 0; i < 8; i++)
    {
        for (n = 0; n < 128; n++)
        {
            switch (pen)
            {
            case Pen_Write:
                OLED_GRAM[n][i] = 0xff;
                break;
            case Pen_Clear:
                OLED_GRAM[n][i] = 0x00;
                break;
            case Pen_Inversion:
                OLED_GRAM[n][i] = 0xff - OLED_GRAM[n][i];
                break;
            default:
                break;
            }
        }
    }
}
/**
 * @brief          初始化OLED模块，
 * @param[in]      none
 * @retval         none
 */
void OLED_init(void)
{
    OLED_RST_Clr();
    DWT_Delay_ms(500);
    OLED_RST_Set();

    oled_write_byte(0xae, OLED_CMD); // turn off oled panel
    oled_write_byte(0x00, OLED_CMD); // set low column address
    oled_write_byte(0x10, OLED_CMD); // set high column address
    oled_write_byte(0x40, OLED_CMD); // set start line address
    oled_write_byte(0x81, OLED_CMD); // set contrast control resigter
    oled_write_byte(0xcf, OLED_CMD); // set SEG output current brightness
    oled_write_byte(0xa1, OLED_CMD); // set SEG/column mapping
    oled_write_byte(0xc8, OLED_CMD); // set COM/row scan direction
    oled_write_byte(0xa6, OLED_CMD); // set nomarl display
    oled_write_byte(0xa8, OLED_CMD); // set multiplex display
    oled_write_byte(0x3f, OLED_CMD); // 1/64 duty
    oled_write_byte(0xd3, OLED_CMD); // set display offset
    oled_write_byte(0x00, OLED_CMD); // not offest
    oled_write_byte(0xd5, OLED_CMD); // set display clock divide ratio/oscillator frequency
    oled_write_byte(0x80, OLED_CMD); // set divide ratio
    oled_write_byte(0xd9, OLED_CMD); // set pre-charge period
    oled_write_byte(0xf1, OLED_CMD); // pre-charge: 15 clocks, discharge: 1 clock
    oled_write_byte(0xda, OLED_CMD); // set com pins hardware configuration
    oled_write_byte(0x12, OLED_CMD); //
    oled_write_byte(0xdb, OLED_CMD); // set vcomh
    oled_write_byte(0x40, OLED_CMD); // set vcom deselect level
    oled_write_byte(0x20, OLED_CMD); // set page addressing mode
    oled_write_byte(0x02, OLED_CMD); //
    oled_write_byte(0x8d, OLED_CMD); // set charge pump enable/disable
    oled_write_byte(0x14, OLED_CMD); // charge pump disable
    oled_write_byte(0xa4, OLED_CMD); // disable entire dispaly on
    oled_write_byte(0xa6, OLED_CMD); // disable inverse display on
    oled_write_byte(0xaf, OLED_CMD); // turn on oled panel

    oled_write_byte(0xaf, OLED_CMD); // display on

    OLED_clear(Pen_Clear);
    OLED_set_pos(0, 0);
}

/**
 * @brief          打开OLED显示
 * @param[in]      none
 * @retval         none
 */
void OLED_display_on(void)
{
    oled_write_byte(0x8d, OLED_CMD);
    oled_write_byte(0x14, OLED_CMD);
    oled_write_byte(0xaf, OLED_CMD);
}

/**
 * @brief          关闭OLED显示
 * @param[in]      none
 * @retval         none
 */
void OLED_display_off(void)
{
    oled_write_byte(0x8d, OLED_CMD);
    oled_write_byte(0x10, OLED_CMD);
    oled_write_byte(0xae, OLED_CMD);
}

/**
 * @brief          设置光标起点(x,y)
 * @param[in]      x:x轴, 从 0 到 127
 * @param[in]      y:y轴, 从 0 到 7
 * @retval         none
 */
void OLED_set_pos(uint8_t x, uint8_t y)
{
    x += 2;
    oled_write_byte((0xb0 + y), OLED_CMD);               // set page address y
    oled_write_byte(((x & 0xf0) >> 4) | 0x10, OLED_CMD); // set column high address
    oled_write_byte((x & 0x0f), OLED_CMD);               // set column low address
}

/**
  * @brief          操作GRAM中的一个位，相当于操作屏幕的一个点
  * @param[in]      x:x轴,  [0,X_WIDTH-1]
  * @param[in]      y:y轴,  [0,Y_WIDTH-1]
  * @param[in]      pen: 操作类型,
                        PEN_CLEAR: 设置 (x,y) 点为 0
                        PEN_WRITE: 设置 (x,y) 点为 1
                        PEN_INVERSION: (x,y) 值反转
  * @retval         none
  */
void OLED_draw_point(int8_t x, int8_t y, Pen_Typedef pen)
{
    uint8_t page = 0, row = 0;

    /* check the corrdinate */
    if ((x < 0) || (x > (X_WIDTH - 1)) || (y < 0) || (y > (Y_WIDTH - 1)))
    {
        return;
    }
    page = y / 8;
    row = y % 8;

    switch (pen)
    {
    case Pen_Write:
        OLED_GRAM[x][page] |= 1 << row;
        break;
    case Pen_Inversion:
        OLED_GRAM[x][page] ^= 1 << row;
        break;
    case Pen_Clear:
        OLED_GRAM[x][page] &= ~(1 << row);
        break;
    default:
        break;
    }
}

/**
 * @brief          画一条直线，从(x1,y1)到(x2,y2)
 * @param[in]      x1: 起点
 * @param[in]      y1: 起点
 * @param[in]      x2: 终点
 * @param[in]      y2: 终点
 * @param[in]      pen: 操作类型,PEN_CLEAR,PEN_WRITE,PEN_INVERSION.
 * @retval         none
 */

void OLED_draw_line(uint8_t x1, uint8_t y1, uint8_t x2, uint8_t y2, Pen_Typedef pen)
{
    uint8_t col = 0, row = 0;
    uint8_t x_st = 0, x_ed = 0, y_st = 0, y_ed = 0;
    float k = 0.0f, b = 0.0f;

    if (y1 == y2)
    {
        (x1 <= x2) ? (x_st = x1) : (x_st = x2);
        (x1 <= x2) ? (x_ed = x2) : (x_ed = x1);

        for (col = x_st; col <= x_ed; col++)
        {
            OLED_draw_point(col, y1, pen);
        }
    }
    else if (x1 == x2)
    {
        (y1 <= y2) ? (y_st = y1) : (y_st = y2);
        (y1 <= y2) ? (y_ed = y2) : (y_ed = y1);

        for (row = y_st; row <= y_ed; row++)
        {
            OLED_draw_point(x1, row, pen);
        }
    }
    else
    {
        k = ((float)(y2 - y1)) / (x2 - x1);
        b = (float)y1 - k * x1;

        (x1 <= x2) ? (x_st = x1) : (x_st = x2);
        (x1 <= x2) ? (x_ed = x2) : (x_ed = x2);

        for (col = x_st; col <= x_ed; col++)
        {
            OLED_draw_point(col, (uint8_t)(col * k + b), pen);
        }
    }
}

/**
 * @brief          显示一个字符
 * @param[in]      row: 字符的开始行
 * @param[in]      col: 字符的开始列
 * @param[in]      chr: 字符
 * @retval         none
 */
void OLED_show_char(uint8_t row, uint8_t col, uint8_t chr)
{
    uint8_t x = col * 6;
    uint8_t y = row * 12;
    uint8_t temp, t, t1;
    uint8_t y0 = y;
    chr = chr - ' ';

    for (t = 0; t < 12; t++)
    {
        temp = asc2_1206[chr][t];

        for (t1 = 0; t1 < 8; t1++)
        {
            if (temp & 0x80)
                OLED_draw_point(x, y, Pen_Write);
            else
                OLED_draw_point(x, y, Pen_Clear);

            temp <<= 1;
            y++;
            if ((y - y0) == 12)
            {
                y = y0;
                x++;
                break;
            }
        }
    }
}

/**
 * @brief          显示一个字符串
 * @param[in]      row: 字符串的开始行
 * @param[in]      col: 字符串的开始列
 * @param[in]      chr: 字符串
 * @retval         none
 */
void OLED_show_string(uint8_t row, uint8_t col, uint8_t *chr)
{
    uint8_t n = 0;

    while (chr[n] != '\0')
    {
        OLED_show_char(row, col, chr[n]);
        col++;

        if (col > 20)
        {
            col = 0;
            row += 1;
        }
        n++;
    }
}
//m^n
static uint32_t oled_pow(uint8_t m, uint8_t n)
{
    uint32_t result = 1;

    while (n--)
        result *= m;

    return result;
}
/**
 * @brief   show a number
 * @param   row: row of number
 * @param   col: column of number
 * @param   num: the number ready to show
 * @param   mode: 0x01, fill number with '0'; 0x00, fill number with spaces
 * @param   len: the length of the number
 * @retval  None
 */
void OLED_show_num(uint8_t row, uint8_t col, uint32_t num, uint8_t mode, uint8_t len)
{
    uint8_t t, temp;
    uint8_t enshow = 0;

    for (t = 0; t < len; t++)
    {
        temp = (num / oled_pow(10, len - t -1)) % 10;

        if (enshow == 0 && t < (len - 1))
        {
            if (temp == 0)
            {
                if (mode == 0)
                    OLED_show_char(row, col + t, ' ');
                else
                    OLED_show_char(row, col + t, '0');
                continue;
            }
            else
                enshow = 1;
        }

        OLED_show_char(row, col + t, temp + '0');
    }
}


/**
 * @brief          格式输出
 * @param[in]      row: 开始列，0 <= row <= 4;
 * @param[in]      col: 开始行， 0 <= col <= 20;
 * @param[in]      *fmt:格式化输出字符串
 * @note           如果字符串长度大于一行，额外的字符会换行
 * @retval         none
 */
void OLED_printf(uint8_t row, uint8_t col, const char *fmt, ...)
{
    static uint8_t LCD_BUF[128] = {0};
    static va_list ap;
    uint8_t remain_size = 0;

    if ((row > 4) || (col > 20))
    {
        return;
    }
    va_start(ap, fmt);

    vsprintf((char *)LCD_BUF, fmt, ap);

    va_end(ap);

    remain_size = 21 - col;

    LCD_BUF[remain_size] = '\0';

    OLED_show_string(row, col, LCD_BUF);
}

/**
 * @brief          发送数据到OLED的GRAM
 * @param[in]      none
 * @retval         none
 */
void OLED_refresh_gram(void)
{
    uint8_t i, n;

    for (i = 0; i < 8; i++)
    {
        OLED_set_pos(0, i);
        for (n = 0; n < 128; n++)
        {
            oled_write_byte(OLED_GRAM[n][i], OLED_DATA);
        }
    }
}

/**
 * @brief          显示RM的LOGO
 * @param[in]      none
 * @retval         none
 */
void OLED_LOGO(void)
{
    OLED_clear(Pen_Clear);
    uint8_t temp_char = 0;
    uint8_t x = 0, y = 0;
    uint8_t i = 0;
    for (; y < 64; y += 8)
    {
        for (x = 0; x < 128; x++)
        {
            temp_char = LOGO_BMP[x][y / 8];
            for (i = 0; i < 8; i++)
            {
                if (temp_char & 0x80)
                    OLED_draw_point(x, y + i, Pen_Write);
                else
                    OLED_draw_point(x, y + i, Pen_Clear);
                temp_char <<= 1;
            }
        }
    }
    OLED_refresh_gram();
}

OLED_button_e GetOlED_Button(void)
{
    float button_vol =0 ;
    HAL_ADC_Start(&hadc1);
    HAL_ADC_PollForConversion(&hadc1, 1);  
    if(HAL_IS_BIT_SET(HAL_ADC_GetState(&hadc1),HAL_ADC_STATE_REG_EOC))
        button_vol=HAL_ADC_GetValue(&hadc1);
    if(button_vol>4000)
        return OLED_BUTTON_NONE;
    else if(button_vol>3000)
        return OLED_BUTTON_DOWN;
    else if(button_vol>2000)
        return OLED_BUTTON_UP;
    else if(button_vol>1000)
        return OLED_BUTTON_RIGHT;
    else if(button_vol>500)
        return OLED_BUTTON_LEFT;
    else if(button_vol==0)
        return OLED_BUTTON_MID;
    else
        return OLED_BUTTON_NONE;
}