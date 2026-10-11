/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.h
  * @brief          : Header for main.c file.
  *                   This file contains the common defines of the application.
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2023 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */

/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __MAIN_H
#define __MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "stm32f4xx_hal.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */

/* USER CODE END Includes */

/* Exported types ------------------------------------------------------------*/
/* USER CODE BEGIN ET */

/* USER CODE END ET */

/* Exported constants --------------------------------------------------------*/
/* USER CODE BEGIN EC */

/* USER CODE END EC */

/* Exported macro ------------------------------------------------------------*/
/* USER CODE BEGIN EM */

/* USER CODE END EM */

/* Exported functions prototypes ---------------------------------------------*/
void Error_Handler(void);

/* USER CODE BEGIN EFP */

/* USER CODE END EFP */

/* Private defines -----------------------------------------------------------*/
#define MAG_INT_Pin GPIO_PIN_3
#define MAG_INT_GPIO_Port GPIOE
#define MAG_RST_Pin GPIO_PIN_2
#define MAG_RST_GPIO_Port GPIOE
#define IMU_INT_Pin GPIO_PIN_8
#define IMU_INT_GPIO_Port GPIOB
#define Laser_Pin GPIO_PIN_13
#define Laser_GPIO_Port GPIOG
#define OLED_DC_Pin GPIO_PIN_9
#define OLED_DC_GPIO_Port GPIOB
#define Power1_Pin GPIO_PIN_2
#define Power1_GPIO_Port GPIOH
#define Power2_Pin GPIO_PIN_3
#define Power2_GPIO_Port GPIOH
#define Power3_Pin GPIO_PIN_4
#define Power3_GPIO_Port GPIOH
#define D8_Pin GPIO_PIN_8
#define D8_GPIO_Port GPIOG
#define Power4_Pin GPIO_PIN_5
#define Power4_GPIO_Port GPIOH
#define D7_Pin GPIO_PIN_7
#define D7_GPIO_Port GPIOG
#define D6_Pin GPIO_PIN_6
#define D6_GPIO_Port GPIOG
#define D5_Pin GPIO_PIN_5
#define D5_GPIO_Port GPIOG
#define D4_Pin GPIO_PIN_4
#define D4_GPIO_Port GPIOG
#define D3_Pin GPIO_PIN_3
#define D3_GPIO_Port GPIOG
#define D2_Pin GPIO_PIN_2
#define D2_GPIO_Port GPIOG
#define HJ_L1_Pin GPIO_PIN_0
#define HJ_L1_GPIO_Port GPIOC
#define HJ_L2_Pin GPIO_PIN_1
#define HJ_L2_GPIO_Port GPIOC
#define KEY_Pin GPIO_PIN_2
#define KEY_GPIO_Port GPIOB
#define KEY_EXTI_IRQn EXTI2_IRQn
#define D1_Pin GPIO_PIN_1
#define D1_GPIO_Port GPIOG
#define BUZZER_Pin GPIO_PIN_6
#define BUZZER_GPIO_Port GPIOH
#define HJ_M_Pin GPIO_PIN_4
#define HJ_M_GPIO_Port GPIOA
#define LED_R_Pin GPIO_PIN_11
#define LED_R_GPIO_Port GPIOE
#define HJ_R1_Pin GPIO_PIN_1
#define HJ_R1_GPIO_Port GPIOB
#define HJ_R2_Pin GPIO_PIN_0
#define HJ_R2_GPIO_Port GPIOB
#define LED_G_Pin GPIO_PIN_14
#define LED_G_GPIO_Port GPIOF
#define OLED_RST_Pin GPIO_PIN_10
#define OLED_RST_GPIO_Port GPIOB

/* USER CODE BEGIN Private defines */

/* USER CODE END Private defines */

#ifdef __cplusplus
}
#endif

#endif /* __MAIN_H */
