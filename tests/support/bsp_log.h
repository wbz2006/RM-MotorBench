#ifdef MB_TEST_LOG_HEADER
#include MB_TEST_LOG_HEADER
#else
#include <stdio.h>
#define LOGERROR(...) ((void)0)
#define LOGWARNING(...) ((void)0)
#define LOGINFO(...) ((void)0)
#endif
