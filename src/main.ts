import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule);

  // chamando os hooks de desligamento aguardando o sigterm e sigint 

    app.enableShutdownHooks();
    await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();