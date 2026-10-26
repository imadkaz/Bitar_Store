import { app } from './app';
import config from './config';
import logger from './utils/logger';

app.listen(config.port, config.host, () => {
    logger.info(`Server is running on port ${config.port}`);
});