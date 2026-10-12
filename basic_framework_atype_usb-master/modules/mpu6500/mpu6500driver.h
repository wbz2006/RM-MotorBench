#ifndef MPU6500Driver_H
#define MPU6500Driver_H
#include "mpu6500_reg.h"
#include "ist8310_reg.h" 
#include "spi.h"
#include "bsp_dwt.h"
#define MPU_HSPI hspi5
#define MPU_NSS_LOW HAL_GPIO_WritePin(GPIOF, GPIO_PIN_6, GPIO_PIN_RESET)
#define MPU_NSS_HIGH HAL_GPIO_WritePin(GPIOF, GPIO_PIN_6, GPIO_PIN_SET)
#define MPU_DELAY(x) DWT_Delay_ms(x)

#define MPU6500_ACCEL_2G_SEN 0.00059814453125f
#define MPU6500_ACCEL_4G_SEN 0.0011962890625f
#define MPU6500_ACCEL_8G_SEN 0.002392578125f
#define MPU6500_ACCEL_16G_SEN 0.00478515625f

#define MPU6500_GYRO_2000_SEN 0.00106422513550135501355013550136
#define MPU6500_GYRO_1000_SEN 5.3211256775067750677506775067751e-4
#define MPU6500_GYRO_500_SEN 2.6646247667514843087362171331637e-4
#define MPU6500_GYRO_250_SEN 1.3323123833757421543681085665818e-4

uint8_t mpu_write_byte(uint8_t const reg, uint8_t const data);
uint8_t mpu_read_byte(uint8_t const reg);
uint8_t mpu_read_bytes(uint8_t const regAddr, uint8_t* pData, uint8_t len);

void mpu6500_device_init(void);


#endif // !MPU6500Driver_H
