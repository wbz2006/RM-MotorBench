
#ifndef OLED_H
#define OLED_H
#include <stdint.h>
#include "spi.h"
#include "stm32f4xx_hal.h"
#define Max_Column      128
#define Max_Row         64

#define X_WIDTH         128
#define Y_WIDTH         64

#define OLED_CMD        0x00
#define OLED_DATA       0x01

#define CHAR_SIZE_WIDTH     6
#define VHAR_SIZE_HIGHT     12

#define OLED_CMD_Set()      HAL_GPIO_WritePin(OLED_DC_GPIO_Port, OLED_DC_Pin, GPIO_PIN_SET)
#define OLED_CMD_Clr()      HAL_GPIO_WritePin(OLED_DC_GPIO_Port, OLED_DC_Pin, GPIO_PIN_RESET)

#define OLED_RST_Set()      HAL_GPIO_WritePin(OLED_RST_GPIO_Port, OLED_RST_Pin, GPIO_PIN_SET)
#define OLED_RST_Clr()      HAL_GPIO_WritePin(OLED_RST_GPIO_Port, OLED_RST_Pin, GPIO_PIN_RESET)

typedef enum
{
  OLED_BUTTON_NONE = 0,
  OLED_BUTTON_MID = 1,
  OLED_BUTTON_LEFT = 2,
  OLED_BUTTON_RIGHT = 3,
  OLED_BUTTON_UP = 4,
  OLED_BUTTON_DOWN = 5,
}OLED_button_e;
typedef enum
{
    Pen_Clear = 0x00,
    Pen_Write = 0x01,
    Pen_Inversion = 0x02,
}Pen_Typedef;

/**
 * @brief          初始化OLED模块，
 * @param[in]      none
 * @retval         none
 */
extern void OLED_init(void);

/**
 * @brief          打开OLED显示
 * @param[in]      none
 * @retval         none
 */
extern void OLED_display_on(void);

/**
 * @brief          关闭OLED显示
 * @param[in]      none
 * @retval         none
 */
extern void OLED_display_off(void);


/**
 * @brief          设置光标起点(x,y)
 * @param[in]      x:x轴, 从 0 到 127
 * @param[in]      y:y轴, 从 0 到 7
 * @retval         none
 */
extern void OLED_set_pos(uint8_t x, uint8_t y);

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
extern void OLED_draw_point(int8_t x, int8_t y, Pen_Typedef pen);

/**
 * @brief          画一条直线，从(x1,y1)到(x2,y2)
 * @param[in]      x1: 起点
 * @param[in]      y1: 起点
 * @param[in]      x2: 终点
 * @param[in]      y2: 终点
 * @param[in]      pen: 操作类型,PEN_CLEAR,PEN_WRITE,PEN_INVERSION.
 * @retval         none
 */
extern void OLED_draw_line(uint8_t x1, uint8_t y1, uint8_t x2, uint8_t y2, Pen_Typedef pen);

/**
 * @brief          显示一个字符
 * @param[in]      row: 字符的开始行
 * @param[in]      col: 字符的开始列
 * @param[in]      chr: 字符
 * @retval         none
 */
extern void OLED_show_char(uint8_t row, uint8_t col, uint8_t chr);

/**
 * @brief          显示一个字符串
 * @param[in]      row: 字符串的开始行
 * @param[in]      col: 字符串的开始列
 * @param[in]      chr: 字符串
 * @retval         none
 */
extern void OLED_show_string(uint8_t row, uint8_t col, uint8_t *chr);

/**
 * @brief          格式输出
 * @param[in]      row: 开始列，0 <= row <= 4;
 * @param[in]      col: 开始行， 0 <= col <= 20;
 * @param[in]      *fmt:格式化输出字符串
 * @note           如果字符串长度大于一行，额外的字符会换行
 * @retval         none
 */
extern void OLED_printf(uint8_t row, uint8_t col, const char *fmt, ...);


/**
 * @brief          发送数据到OLED的GRAM
 * @param[in]      none
 * @retval         none
 */
extern void OLED_refresh_gram(void);


/**
 * @brief          显示RM的LOGO
 * @param[in]      none
 * @retval         none
 */
extern void OLED_LOGO(void);

extern OLED_button_e GetOlED_Button(void);
#endif
