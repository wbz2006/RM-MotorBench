#ifndef BSP_CAN_H
#define BSP_CAN_H

#include <stdint.h>
#include "can.h"

// 最多能够支持的CAN设备数
#define CAN_MX_REGISTER_CNT 16     // 这个数量取决于CAN总线的负载
#define MX_CAN_FILTER_CNT (2 * 14) // 最多可以使用的CAN过滤器数量,目前远不会用到这么多
#define DEVICE_CAN_CNT 2           // 根据板子设定,F407IG有CAN1,CAN2,因此为2;F334只有一个,则设为1
// 如果只有1个CAN,还需要把bsp_can.c中所有的hcan2变量改为hcan1(别担心,主要是总线和FIFO的负载均衡,不影响功能)

/* can instance typedef, every module registered to CAN should have this variable */
#pragma pack(1)
typedef struct _
{
    CAN_HandleTypeDef *can_handle; // can句柄
    CAN_TxHeaderTypeDef txconf;    // CAN报文发送配置
    uint32_t tx_id;                // 发送id
    uint32_t tx_mailbox;           // CAN消息填入的邮箱号
    uint8_t tx_buff[8];            // 发送缓存,发送消息长度可以通过CANSetDLC()设定,最大为8
    uint8_t rx_buff[8];            // 接收缓存,最大消息长度为8
    uint32_t rx_id;                // 接收id
    uint8_t rx_len;                // 接收长度,可能为0-8
    // 接收的回调函数,用于解析接收到的数据
    void (*can_module_callback)(struct _ *); // callback needs an instance to tell among registered ones
    void *id;                                // 使用can外设的模块指针(即id指向的模块拥有此can实例,是父子关系)
    uint8_t filter_bank;                     // 本实例占用的接收过滤器编号,供 CANUnregister() 回收
} CANInstance;
#pragma pack()

/* CAN实例初始化结构体,将此结构体指针传入注册函数 */
typedef struct
{
    CAN_HandleTypeDef *can_handle;              // can句柄
    uint32_t tx_id;                             // 发送id
    uint32_t rx_id;                             // 接收id
    void (*can_module_callback)(CANInstance *); // 处理接收数据的回调函数
    void *id;                                   // 拥有can实例的模块地址,用于区分不同的模块(如果有需要的话),如果不需要可以不传入
} CAN_Init_Config_s;

/**
 * @brief Register a module to CAN service,remember to call this before using a CAN device
 *        注册(初始化)一个can实例,需要传入初始化配置的指针.
 * @param config init config
 * @return CANInstance* can instance owned by module
 */
CANInstance *CANRegister(CAN_Init_Config_s *config);

/**
 * @brief 修改CAN发送报文的数据帧长度;注意最大长度为8,在没有进行修改的时候,默认长度为8
 *
 * @param _instance 要修改长度的can实例
 * @param length    设定长度
 */
void CANSetDLC(CANInstance *_instance, uint8_t length);

/**
 * @brief transmit mesg through CAN device,通过can实例发送消息
 *        发送前需要向CAN实例的tx_buff写入发送数据
 * 
 * @attention 超时时间不应该超过调用此函数的任务的周期,否则会导致任务阻塞
 * 
 * @param timeout 超时时间,单位为ms;后续改为us,获得更精确的控制
 * @param _instance* can instance owned by module
 */
uint8_t CANTransmit(CANInstance *_instance,uint8_t timeout);

/**
 * @brief 注销一个 CAN 实例,并释放它占用的接收过滤器
 *
 * @note 新增接口,用于支持运行期动态创建/销毁电机:
 *       原实现中过滤器只会递增分配、从不释放,
 *       而 CAN1/CAN2 各只有 14 个 filter bank(0-13 / 14-27),
 *       电机反复增删会很快耗尽。本接口把对应 bank 禁用并回收索引。
 *
 * @param _instance 待注销的实例;传 NULL 直接返回
 * @return 0 成功,1 未找到该实例
 *
 * @attention 必须在电机停止输出后调用(先 DJIMotorStop/DMMotorStop 并等待一帧),
 *            否则控制任务可能仍持有已释放的指针。
 */
uint8_t CANUnregister(CANInstance *_instance);

/**
 * @brief 查询某条总线上已占用的过滤器数量
 *
 * @param can_handle CAN1 或 CAN2 句柄
 * @return 该总线已使用的 filter bank 数
 *
 * @note 用于上位机在动态创建电机前预判资源是否够用,避免用户点到一半才失败。
 */
uint8_t CANGetFilterUsed(CAN_HandleTypeDef *can_handle);

/**
 * @brief 查询还能动态创建多少个该总线的电机实例
 *
 * @param can_handle CAN1 或 CAN2 句柄
 * @return 剩余可用 filter bank 数
 */
uint8_t CANGetFilterFree(CAN_HandleTypeDef *can_handle);

#endif
